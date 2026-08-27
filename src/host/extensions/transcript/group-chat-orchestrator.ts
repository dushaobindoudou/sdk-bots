import {
  GROUP_MAX_MEMBER_TURNS,
  GROUP_MAX_MESSAGES_PER_TURN,
  GROUP_MAX_ROUNDS,
  SHARED_ROOM_HISTORY_LIMIT,
  buildGroupMemberSystemPrompt,
  buildGroupTurnPrompt,
  groupDisplayName,
  isPassContent,
  stripGroupPassToken,
  messagesSinceMemberLastSpoke,
  orderRoundSpeakers,
  parseGroupMentions,
  resolveResponders,
  type GroupDescription,
  type GroupMember,
  type GroupMessage,
} from "../../groups/group-chat.js";

export interface GroupOrchestratorDeps {
  resolveMembers(ids: readonly string[]): Promise<GroupMember[]>;
  readHistory(): readonly GroupMessage[];
  isCurrent(): boolean;
  runMemberTurn(args: {
    member: GroupMember;
    systemPrompt: string;
    prompt: string;
  }): Promise<readonly string[]>;
  postMemberMessage(member: GroupMember, content: string): void;
  finalizeMemberTurn?(member: GroupMember): void;
  isSharedRoom?: boolean;
}

/** Drives a bounded, epoch-cancellable round robin for one room turn. */
export class GroupChatOrchestrator {
  constructor(readonly deps: GroupOrchestratorDeps) {}

  async run(args: {
    group: GroupDescription;
    memberIds: readonly string[];
  }): Promise<void> {
    const members = await this.deps.resolveMembers(args.memberIds);
    if (members.length === 0) return;

    const memberById = new Map(members.map((member) => [member.id, member]));
    let totalMessages = 0;

    for (let round = 0; round < GROUP_MAX_ROUNDS; round += 1) {
      if (!this.deps.isCurrent()) return;
      const responderIds = resolveResponders(
        members,
        this.deps.readHistory(),
      ).map((member) => member.id);
      let messagesThisRound = 0;

      for (const memberId of orderRoundSpeakers(responderIds, round)) {
        if (totalMessages >= GROUP_MAX_MEMBER_TURNS || !this.deps.isCurrent())
          return;
        const member = memberById.get(memberId);
        if (member == null) continue;

        const sent = await this.runOneTurn(args.group, member, members);
        let hitCap = false;
        for (const content of sent) {
          this.deps.postMemberMessage(member, content);
          totalMessages += 1;
          messagesThisRound += 1;
          if (totalMessages >= GROUP_MAX_MEMBER_TURNS) {
            hitCap = true;
            break;
          }
        }
        this.deps.finalizeMemberTurn?.(member);
        if (hitCap) return;
      }

      if (messagesThisRound === 0) return;
    }
  }

  async runOneTurn(
    group: GroupDescription,
    member: GroupMember,
    members: readonly GroupMember[],
  ): Promise<string[]> {
    const peers = members.filter((other) => other.id !== member.id);
    const history = this.deps.readHistory();
    const newMessages =
      this.deps.isSharedRoom === true
        ? history.slice(-SHARED_ROOM_HISTORY_LIMIT)
        : messagesSinceMemberLastSpoke(history, member.id);
    let addressed = false;
    for (let index = history.length - 1; index >= 0; index -= 1) {
      if (history[index]?.speaker.kind !== "user") continue;
      const mentions = parseGroupMentions(history[index]!.content, members);
      addressed = mentions.isEveryone || mentions.memberIds.includes(member.id);
      break;
    }
    const sent = await this.deps.runMemberTurn({
      member,
      systemPrompt: buildGroupMemberSystemPrompt(member, group, peers, {
        isSharedRoom: this.deps.isSharedRoom === true,
      }),
      prompt: buildGroupTurnPrompt({ member, group, peers, newMessages, addressed }),
    });

    const spoken: string[] = [];
    for (const rawContent of sent) {
      // "(pass)+commentary" is a pass with self-justification glued on: strip the
      // token, then relay only any real remainder (commentary), never the token.
      const content = stripGroupPassToken(rawContent);
      // Audit trail: every member-turn output (passes, narration, receipts,
      // answers alike) goes to the host log stream, so the console logs view
      // shows the full process even when the chat view renders it as a quiet
      // status note. pass = silent skip; note = pass with commentary; say = room message.
      const kind = isPassContent(content) ? (content.length > 0 ? "note" : "pass") : "say";
      console.log(
        `[group-chat] ${groupDisplayName(group)}/${member.name} ${kind}: ${rawContent.trim().slice(0, 500)}`,
      );
      if (isPassContent(content)) continue;
      const trimmed = content.trim();
      if (trimmed.length === 0) continue;
      spoken.push(trimmed);
      if (spoken.length >= GROUP_MAX_MESSAGES_PER_TURN) break;
    }
    return spoken;
  }
}
