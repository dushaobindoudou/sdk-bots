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

      if (messagesThisRound === 0) break;
    }

    // Wind-down sweeps: relay + closing, at most two passes. The relay sweep
    // chases unanswered @-handoffs (observed 2026-09-02 玄骨-续: 导演 "@编剧 直接
    // 交我，我接活" died at the round cap, the mentioned peer never woken). The
    // closing sweep then asks every member who spoke in this exchange to finish
    // anything they promised in prose ("整改清单（我直接驱动重出）" followed by
    // only @-replies and passes) or @-hand it onward — execute now, not restate.
    // A closing post with fresh @s re-arms the relay in sweep two; silence ends
    // the room. Everything stays bounded by GROUP_MAX_MEMBER_TURNS.
    for (let sweep = 0; sweep < 2; sweep += 1) {
      for (;;) {
        if (totalMessages >= GROUP_MAX_MEMBER_TURNS || !this.deps.isCurrent()) return;
        const pendingIds = this.pendingMentionTargets(this.deps.readHistory(), members);
        if (pendingIds.length === 0) break;
        let relayMessages = 0;
        for (const memberId of pendingIds) {
          if (totalMessages >= GROUP_MAX_MEMBER_TURNS || !this.deps.isCurrent()) return;
          const member = memberById.get(memberId);
          if (member == null) continue;
          const sent = await this.runOneTurn(args.group, member, members);
          for (const content of sent) {
            this.deps.postMemberMessage(member, content);
            totalMessages += 1;
            relayMessages += 1;
            if (totalMessages >= GROUP_MAX_MEMBER_TURNS) break;
          }
          this.deps.finalizeMemberTurn?.(member);
        }
        if (relayMessages === 0) break;
      }

      const closingAuthors = this.closingAuthors(this.deps.readHistory(), members);
      if (closingAuthors.length === 0) return;
      let closingMessages = 0;
      for (const memberId of closingAuthors) {
        if (totalMessages >= GROUP_MAX_MEMBER_TURNS || !this.deps.isCurrent()) return;
        const member = memberById.get(memberId);
        if (member == null) continue;
        const sent = await this.runOneTurn(args.group, member, members, { closing: true });
        for (const content of sent) {
          this.deps.postMemberMessage(member, content);
          totalMessages += 1;
          closingMessages += 1;
          if (totalMessages >= GROUP_MAX_MEMBER_TURNS) break;
        }
        this.deps.finalizeMemberTurn?.(member);
      }
      if (closingMessages === 0) return;
    }
  }

  /**
   * Distinct authors of member messages in the current exchange (after the last
   * user message), most recent first. Only members who actually spoke can owe
   * the room promised work, so the closing sweep wakes them — not bystanders.
   */
  private closingAuthors(
    history: readonly { speaker: { kind: string; id?: string }; content: string }[],
    members: readonly GroupMember[],
  ): string[] {
    let start = 0;
    for (let index = history.length - 1; index >= 0; index -= 1) {
      if (history[index]?.speaker.kind === "user") {
        start = index;
        break;
      }
    }
    const authors: string[] = [];
    const seen = new Set<string>();
    for (let index = history.length - 1; index >= start; index -= 1) {
      const message = history[index];
      if (message?.speaker.kind !== "member") continue;
      const id = message.speaker.id;
      if (id == null || seen.has(id)) continue;
      if (!members.some((member) => member.id === id)) continue;
      seen.add(id);
      authors.push(id);
    }
    return authors;
  }

  /**
   * Members @-mentioned in a message that came after their own last message:
   * a handoff still awaiting its answer. Scoped to the current exchange
   * (messages after the last user message), so stale mentions from earlier
   * batches never resurrect.
   */
  private pendingMentionTargets(
    history: readonly { speaker: { kind: string; id?: string }; content: string }[],
    members: readonly GroupMember[],
  ): string[] {
    let start = 0;
    for (let index = history.length - 1; index >= 0; index -= 1) {
      if (history[index]?.speaker.kind === "user") {
        start = index;
        break;
      }
    }
    const pending = new Set<string>();
    for (let index = start; index < history.length; index += 1) {
      const message = history[index];
      if (message?.speaker.kind !== "member") continue;
      if (!members.some((member) => member.id === message.speaker.id)) continue;
      for (const id of parseGroupMentions(message.content, members).memberIds) {
        const answered = history
          .slice(index + 1)
          .some((later) => later.speaker.kind === "member" && later.speaker.id === id);
        if (!answered) pending.add(id);
      }
    }
    return [...pending];
  }

  async runOneTurn(
    group: GroupDescription,
    member: GroupMember,
    members: readonly GroupMember[],
    options?: { closing?: boolean },
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
      if (mentions.isEveryone || mentions.memberIds.includes(member.id)) {
        // The mention is served once this member has spoken after it. Re-waking
        // an already-answered member against an empty room forces the "addressed
        // members must not pass" rule to squeeze hallucinated filler out of it.
        addressed = !history
          .slice(index + 1)
          .some((message) => message.speaker.kind === "member" && message.speaker.id === member.id);
      }
      break;
    }
    const sent = await this.deps.runMemberTurn({
      member,
      systemPrompt: buildGroupMemberSystemPrompt(member, group, peers, {
        isSharedRoom: this.deps.isSharedRoom === true,
      }),
      prompt: buildGroupTurnPrompt({ member, group, peers, newMessages, addressed, closing: options?.closing === true }),
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
