export const GROUP_CONFIG_VERSION = 1; export const GROUP_MAX_MEMBER_TURNS = 10; export const GROUP_MAX_ROUNDS = 3; export const GROUP_PROMPT_HISTORY_LIMIT = 24; export const GROUP_MAX_MESSAGES_PER_TURN = 2; export const SHARED_ROOM_HISTORY_LIMIT = 24; export const GROUP_CHAT_TAG_PREFIX = "[Group chat: "; export const SAND_HIDDEN_PROMPT_MARKER = "[SAND_HIDDEN_PROMPT]";
export interface GroupMember { id: string; name: string; description: string } export interface GroupDescription { name: string; description: string } export type GroupMessage = { speaker: { kind: "user"; name?: string } | { kind: "member"; id: string; name: string }; content: string };
export function orderRoundSpeakers<T>(memberIds: readonly T[], round: number): T[] { if (memberIds.length === 0) return []; const offset = (round % memberIds.length + memberIds.length) % memberIds.length; return [...memberIds.slice(offset), ...memberIds.slice(0, offset)]; }
export function isSameMemberSet(a: readonly string[], b: readonly string[]): boolean { if (a.length !== b.length) return false; const set = new Set(a); return b.every((id) => set.has(id)); }
export class SandGroupNestingError extends Error { readonly nestedGroupIds: string[]; constructor(ids: readonly string[]) { super(`A group chat can only contain individual agents, not other group chats. Remove the group chat${ids.length === 1 ? "" : "s"} from the member list.`); this.name = "SandGroupNestingError"; this.nestedGroupIds = [...ids]; } }
export function assertMembersAreNotGroups(ids: readonly string[], isGroupId: (id: string) => boolean): void { const nested = [...new Set(ids)].filter(isGroupId); if (nested.length > 0) throw new SandGroupNestingError(nested); }
export const GROUP_EVERYONE_HANDLES = ["everyone", "all", "所有人", "全员", "大家"] as const;
export function normalizeMentionText(text: string): string { return text.replaceAll("＠", "@").toLowerCase(); }
export function memberMentionHandles(name: string): string[] { const lower = name.trim().toLowerCase(); if (!lower) return []; const handles = new Set([lower, lower.replace(/\s+/g, "")]); const first = lower.split(/\s+/)[0]; if (first) handles.add(first); return [...handles]; }
function isLatinHandle(handle: string): boolean { return /^[a-z0-9]/.test(handle); }
function isHandleBoundary(char: string | undefined): boolean { return char === undefined || !/[a-z0-9_]/i.test(char); }
function handleFits(rest: string, handle: string): boolean {
  if (!rest.startsWith(handle)) return false;
  return isLatinHandle(handle) ? isHandleBoundary(rest[handle.length]) : true;
}

/**
 * The @-mention token proper: everything after "@" up to the first whitespace
 * or sentence punctuation. Exact-handle matching can run against the whole
 * remaining text, but nickname-prefix matching needs the token's true end.
 */
function mentionToken(rest: string): string {
  const m = /^[^\s，。！？、：；,.;:!?\-—()（）[\]【】<>《》"'@#]+/.exec(rest);
  return m !== null ? m[0] : "";
}

/**
 * Nickname-prefix resolution (2026-09-02 玄骨-续实证：剧组全程写 "@摄影 @灯光"，
 * 全名是 摄影指导/灯光师，@ 静默解析为空，委派链条再次断裂)。保守规则：
 *   - 仅 CJK handle（latin 名保持全名/边界匹配不变）；
 *   - token 至少 2 字符；
 *   - 恰好一个成员的 handle 以该 token 开头才解析——有歧义宁可不解析，
 *     也不猜错人（歧义应由机器人改用全名解决）。
 */
function resolvePrefixMention(token: string, members: readonly Pick<GroupMember, "id" | "name">[]): string | null {
  if (token.length < 2) return null;
  const candidates = new Set<string>();
  for (const member of members) {
    if (!member.id) continue;
    for (const handle of memberMentionHandles(member.name)) {
      if (isLatinHandle(handle)) continue;
      if (handle.length > token.length && handle.startsWith(token)) {
        candidates.add(member.id);
        break;
      }
    }
  }
  return candidates.size === 1 ? [...candidates][0]! : null;
}
export function parseGroupMentions(text: string, members: readonly Pick<GroupMember, "id" | "name">[]): { isEveryone: boolean; memberIds: string[] } {
  const normalized = normalizeMentionText(text);
  const memberIds: string[] = [];
  const seen = new Set<string>();
  let isEveryone = false;
  for (let index = normalized.indexOf("@"); index >= 0; index = normalized.indexOf("@", index + 1)) {
    let cursor = index + 1;
    while (normalized[cursor] === " " || normalized[cursor] === "\t") cursor += 1;
    const rest = normalized.slice(cursor);
    if (GROUP_EVERYONE_HANDLES.some((handle) => handleFits(rest, handle))) {
      isEveryone = true;
      continue;
    }
    let best: { id: string; length: number } | null = null;
    for (const member of members) {
      const handles = memberMentionHandles(member.name);
      if (member.id) handles.push(member.id.toLowerCase());
      for (const handle of handles) {
        if (!handleFits(rest, handle)) continue;
        if (best == null || handle.length > best.length) best = { id: member.id, length: handle.length };
      }
    }
    if (best == null) {
      const prefixedId = resolvePrefixMention(mentionToken(rest), members);
      if (prefixedId != null) best = { id: prefixedId, length: 0 };
    }
    if (best != null && !seen.has(best.id)) {
      seen.add(best.id);
      memberIds.push(best.id);
    }
  }
  return { isEveryone, memberIds };
}
/**
 * 本轮该由谁应答。
 *
 * 委派是这个产品的核心用法之一（统筹型成员给专家派活），所以机器人点名同伴
 * 依然授予发言权。但两条放大通道必须堵死，否则房间会自我维持：
 *   - 只有**用户**能寻址全场。机器人说 "@全员" 不得把响应集合扩成所有人
 *     （真实事故：用户只 @ 了一个人，被点名者回复里带了 @全员，下一轮全员被
 *     选举进来，答的全是上一个话题，没人回应用户）。
 *   - 委派只允许**一跳**。被用户直接点名的人可以派活；被派到的人再点名不再
 *     生效，否则 A→B→C→… 可以无限延续。
 *
 * 注意：这里只处理 @ 这一种显式寻址。第三人称指称（"有事找 @X"）、自然语言
 * 全员（"大家都说说"）、隐式追问（"这个数字对吗？"）需要语义判断，由
 * docs/group-turn-taking.md 描述的意图+仲裁层处理，不属于本函数。
 */
export function resolveResponders<T extends Pick<GroupMember, "id" | "name">>(members: readonly T[], history: readonly GroupMessage[]): T[] {
  let start = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) if (history[index]?.speaker.kind === "user") { start = index; break; }
  let everyone = false;
  const addressed = new Set<string>();
  const delegated = new Set<string>();
  for (const message of history.slice(start)) {
    const targets = parseGroupMentions(message.content, members);
    if (message.speaker.kind === "user") {
      everyone ||= targets.isEveryone;
      for (const id of targets.memberIds) addressed.add(id);
      continue;
    }
    if (!addressed.has(message.speaker.id)) continue;
    for (const id of targets.memberIds) delegated.add(id);
  }
  const elected = new Set([...addressed, ...delegated]);
  return everyone || elected.size === 0 ? [...members] : members.filter((member) => elected.has(member.id));
}
export function isPassContent(content: string): boolean { const trimmed = content.trim(); return !trimmed || /^\(?\s*pass\s*\)?\.?$/i.test(trimmed); } export function isPotentialPassPrefix(text: string): boolean { const trimmed = text.trim(); return !trimmed || isPassContent(trimmed) || /^\(?\s*(?:p(?:a(?:s(?:s\s*\)?\.?)?)?)?)?$/i.test(trimmed); }
/** Models sometimes glue commentary after the pass token ("(pass)The answer has already been delivered…"). Strip only a leading PARENTHESIZED token — a bare leading "Pass …" in a real English answer must survive untouched. */
export function stripGroupPassToken(content: string): string { return content.trim().replace(/^\(\s*pass\s*\)[\s.。:：,，;；\-—–]*/i, "").trim(); }
export function buildGroupRedriveNote(): string { return "\n(Redelivery: your previous attempt at this turn was interrupted by a direct message to you. The room has NOT seen any reply from you for the messages above — anything you said or did while handling that direct message stayed in that private chat. If you already did the work, send the result to this room with SendMessage now; otherwise take the turn normally.)"; }
export function formatGroupLine(message: GroupMessage, viewerId: string): string { if (message.speaker.kind === "user") return message.speaker.name ? `${message.speaker.name} (user): ${message.content}` : `User: ${message.content}`; return `${message.speaker.name}${message.speaker.id === viewerId ? " (you)" : ""}: ${message.content}`; } export function formatGroupHistory(history: readonly GroupMessage[], viewerId: string, limit = GROUP_PROMPT_HISTORY_LIMIT): string { const recent = history.slice(-limit); return recent.length === 0 ? "(no messages yet)" : recent.map((message) => formatGroupLine(message, viewerId)).join("\n"); }
export function isGroupTurnPromptText(text: string): boolean { const body = text.startsWith(SAND_HIDDEN_PROMPT_MARKER) ? text.slice(SAND_HIDDEN_PROMPT_MARKER.length) : text; return body.startsWith(GROUP_CHAT_TAG_PREFIX); } export function groupDisplayName(group: GroupDescription): string { return group.name.trim() || "the group"; } export function describeGroup(group: GroupDescription): string { const name = groupDisplayName(group), description = group.description.trim(); return description ? `"${name}" — ${description}` : `"${name}"`; } export function formatGroupChatTag(group: GroupDescription, peers: readonly Pick<GroupMember, "name">[]): string { return `${GROUP_CHAT_TAG_PREFIX}"${groupDisplayName(group)}"${peers.length > 0 ? ` - with ${peers.map((peer) => peer.name).join(", ")}` : ""}]`; }
export function buildGroupMemberSystemPrompt(member: GroupMember, group: GroupDescription, peers: readonly GroupMember[], options: { isSharedRoom?: boolean } = {}): string { const lines = [`You are ${member.name}, one participant in a group chat (${describeGroup(group)}).`]; if (member.description.trim()) lines.push(`Your persona: ${member.description.trim()}`); if (peers.length > 0) lines.push("", "Other participants in the room:", ...peers.map((peer) => `- ${peer.name}${peer.description.trim() ? ` (${peer.description.trim()})` : ""}`)); lines.push("", peers.length > 0 ? `Right now you are speaking in this group chat, with ${peers.map((peer) => peer.name).join(", ")}.` : "Right now you are speaking in this group chat.", `To hand work to a peer or ask them for input, @-mention their name in your message (for example "@制片人 请把需求发上来"): your @-mention delegates the next room turn to that peer. A request without an @-mention wakes nobody — the room cannot answer what it never sees. Abbreviations work when unambiguous ("@摄影" wakes 摄影指导), but prefer full names.`, `When you accept or promise a task, your NEXT turn must execute it with your tools — a plan or a promise ("我马上重出", "稍后交付") is not a deliverable. Unfinished work stays yours until you post the result or @-hand it to the member who will do it.`, options.isSharedRoom ? "This is a cross-user room turn. Tool calls and plain text are private scratch space; only SendMessage plain text is delivered to the room." : "You have your full toolkit in this room. Do the work first, then deliver the result with SendMessage.", "", `Stay fully in character as ${member.name}. The ONLY way to say something the room can see is the SendMessage tool. Keep each message short and conversational. If you have nothing new worth adding, send exactly \"(pass)\" as the entire message — never append explanations after the token. Never reveal private one-on-one context.`, `Speak ONLY as ${member.name}. Never write, ghost-write, continue, restate, or "relay" a message on behalf of another participant, and never begin your own message with another participant's name or title (e.g. 【系统分析师：…】, \"X: …\", \"X · …\") — the room already labels every message with its true speaker, so a message you sign with a peer's name is a forgery even if you are only summarizing their view. If a peer's point matters, attribute it inside your own message (\"X 说过…\") rather than speaking as them. This applies even when your persona describes you as the user's representative or the room's coordinator: coordinate by addressing peers, not by impersonating them.`, "", "Message discipline: at most ONE brief progress note while you work (\"正在查询…\" — a single short line, optional), then exactly ONE final-answer SendMessage. Do NOT send receipts or self-summaries about your reply afterwards (\"已回复…\", \"消息已发出\", \"The turn is complete…\") — the room already saw your answer. If a tool fails, mention it at most briefly in the progress note, then fall back to what you already know and deliver the answer."); return lines.join("\n"); }
export function messagesSinceMemberLastSpoke(history: readonly GroupMessage[], memberId: string): readonly GroupMessage[] { for (let index = history.length - 1; index >= 0; index -= 1) { const speaker = history[index]?.speaker; if (speaker?.kind === "member" && speaker.id === memberId) return history.slice(index + 1); } return history; }
export function buildGroupTurnPrompt(args: { member: GroupMember; group: GroupDescription; peers: readonly GroupMember[]; newMessages: readonly GroupMessage[]; addressed?: boolean; closing?: boolean }): string { const closingNote = args.closing === true && args.addressed !== true ? ` This is the closing check before the room goes quiet: if you promised the room anything you have not delivered yet (a redo, a file, an answer), execute it now with your tools, or @ the member who must act — do not just restate the plan.` : ""; const close = args.addressed === true ? `It's your turn, ${args.member.name}. The user @mentioned you. Reply in character with a single SendMessage — your final answer only, no progress notes or receipts — do not pass.` : `It's your turn, ${args.member.name}. Reply in character with a single SendMessage if you have something worth adding, or send \"(pass)\" alone — nothing after it — if you don't. One message: the final answer only — no progress notes, no receipts. If the room needs nothing from you right now, that is exactly what \"(pass)\" is for — never send standby or status notes (\"随时待命\", \"no new instructions\", \"waiting for tasks\").`; const lines = [formatGroupChatTag(args.group, args.peers), args.newMessages.length === 0 ? "No new messages in the room since your last turn." : `New messages in the room (oldest first):\n${formatGroupHistory(args.newMessages, args.member.id)}`, "", close + closingNote]; return lines.join("\n"); }
