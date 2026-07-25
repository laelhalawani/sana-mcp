/**
 * Stable, presentation-free boundary consumed by the human app.
 *
 * Implementations may use Sana HTTP, local stores, client configuration files,
 * or daemon control. Screens receive only these records and never those raw
 * objects or agent-facing dispatcher strings.
 */

export interface UiIssue {
  field?: string;
  code: string;
  detail?: string;
}

export interface UiFailure {
  code: string;
  detail?: string;
  retryable: boolean;
}

export type UnavailableReasonCode =
  | "not-authenticated"
  | "session-expired"
  | "offline"
  | "timeout"
  | "permission-denied"
  | "unsupported-platform"
  | "not-configured"
  | "not-synced"
  | "dependency-missing"
  | "ownership-unproven"
  | "service-unavailable"
  | "capability-disabled";

export type UnavailableActionCode =
  | "sign-in"
  | "retry"
  | "check-network"
  | "check-permissions"
  | "use-supported-platform"
  | "install-dependency"
  | "configure"
  | "wait-for-sync"
  | "resolve-ownership"
  | "enable-capability";

export interface ActionableUnavailable {
  reason: UnavailableReasonCode;
  action: UnavailableActionCode;
  detail?: string;
}

export type UiResult<Value, Empty extends object = Record<never, never>> =
  | { state: "loading" }
  | { state: "ok"; value: Value }
  | ({ state: "empty" } & Empty)
  | ({ state: "unavailable" } & ActionableUnavailable)
  | { state: "invalid"; issues: readonly UiIssue[] }
  | { state: "error"; error: UiFailure }
  | { state: "cancelled"; reason?: string };

export type Availability<Value> =
  | { availability: "available"; value: Value }
  | ({ availability: "unavailable" } & ActionableUnavailable);

export interface OperationContext {
  signal: AbortSignal;
}

export interface PageRequest {
  page?: number;
  limit?: number;
}

export interface Page<Value> {
  items: readonly Value[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

export interface ProfileIdentity {
  userId: string;
  workspaceId: string;
  displayName?: string;
  email?: string;
}

export type SessionSnapshot =
  | { kind: "signed-out" }
  | { kind: "pending"; email: string; expiresAtMs: number }
  | { kind: "active"; profile: ProfileIdentity; generation: string }
  | { kind: "expired"; profile?: ProfileIdentity }
  | { kind: "transitioning"; from?: ProfileIdentity; to?: ProfileIdentity };

export interface SessionPort {
  get(context: OperationContext): Promise<UiResult<SessionSnapshot>>;
  subscribe(listener: (session: UiResult<SessionSnapshot>) => void): () => void;
}

export type SyncPhase =
  | "idle"
  | "listing"
  | "downloading"
  | "ready"
  | "needs-login"
  | "error";

export interface Progress {
  completed: number;
  total: number;
}

export interface RuntimeStatus {
  profile: ProfileIdentity;
  phase: SyncPhase;
  blocking: boolean;
  transcripts: Progress;
  meetingsAvailable: number;
  lastFullSyncMs: Availability<number>;
  lastIncrementalSyncMs: Availability<number>;
  etaMs: Availability<number>;
  semantic:
    | { capability: "available"; progress: Progress }
    | { capability: "disabled" }
    | ({ capability: "unavailable" } & ActionableUnavailable);
}

export interface StatusPort {
  get(context: OperationContext): Promise<UiResult<RuntimeStatus>>;
  subscribe(listener: (status: UiResult<RuntimeStatus>) => void): () => void;
}

export type MeetingArtifactState =
  | "ready"
  | "downloading"
  | "processing"
  | "unavailable"
  | "corrupt"
  | "error";

export interface MeetingListItem {
  id: string;
  title: string;
  startedAtMs: number;
  transcript: MeetingArtifactState;
}

export interface MeetingListRequest extends PageRequest {
  query?: string;
  sort?: "newest" | "oldest";
  status?: MeetingArtifactState;
  fromMs?: number;
  toMs?: number;
}

export interface MeetingListPort {
  list(
    request: MeetingListRequest,
    context: OperationContext
  ): Promise<UiResult<Page<MeetingListItem>, { filter: MeetingListRequest }>>;
}

export interface SearchMatch {
  meetingId: string;
  meetingTitle: string;
  startedAtMs: number;
  lineNumber: number;
  text: string;
}

export interface SearchRequest extends PageRequest {
  query: string;
  sort?: "best" | "newest" | "oldest";
  fromMs?: number;
  toMs?: number;
}

export interface SearchPage extends Page<SearchMatch> {
  query: string;
  mode: "keyword" | "hybrid";
  degradation?: { capability: "semantic" } & ActionableUnavailable;
  complete: true;
}

export interface SearchPort {
  search(
    request: SearchRequest,
    context: OperationContext
  ): Promise<UiResult<SearchPage, { query: string }>>;
}

export interface TranscriptLine {
  lineNumber: number;
  speaker?: string;
  timestampMs?: number;
  text: string;
}

export interface TranscriptDocument {
  meeting: MeetingListItem;
  lines: readonly TranscriptLine[];
  wordCount: number;
  revision: string;
}

export interface TranscriptPort {
  read(
    meetingId: string,
    context: OperationContext
  ): Promise<UiResult<TranscriptDocument, { meetingId: string }>>;
}

export interface ActionItem {
  action: string;
  assignedTo?: string;
  dueDate?: string;
}

export interface NoteTopic {
  topic: string;
  notes: readonly string[];
}

export interface MeetingSummary {
  meetingId: string;
  meetingTitle: string;
  short?: string;
  full?: string;
  actionItems: readonly ActionItem[];
  notes: readonly NoteTopic[];
}

export interface SummaryPort {
  read(
    meetingId: string,
    context: OperationContext
  ): Promise<UiResult<MeetingSummary, { meetingId: string }>>;
}

export interface Participant {
  displayName?: string;
  email?: string;
  isHost: boolean;
}

export interface MeetingParticipants {
  meetingId: string;
  meetingTitle: string;
  participants: readonly Participant[];
}

export interface ParticipantsPort {
  read(
    meetingId: string,
    context: OperationContext
  ): Promise<UiResult<MeetingParticipants, { meetingId: string }>>;
}

export interface RecordingLink {
  meetingId: string;
  meetingTitle: string;
  url: URL;
  expiresAtMs?: number;
}

export interface RecordingPort {
  get(
    meetingId: string,
    context: OperationContext
  ): Promise<UiResult<RecordingLink, { meetingId: string }>>;
}

export interface RequestCodeInput {
  email: string;
  workspaceId?: string;
}

export interface PendingAuthentication {
  email: string;
  expiresAtMs: number;
  challengeId: string;
}

export interface VerifyCodeInput {
  challengeId: string;
  code: string;
}

export interface AuthPort {
  requestCode(
    input: RequestCodeInput,
    context: OperationContext
  ): Promise<UiResult<PendingAuthentication>>;
  verifyCode(
    input: VerifyCodeInput,
    context: OperationContext
  ): Promise<UiResult<ProfileIdentity>>;
  signOut(context: OperationContext): Promise<UiResult<{ signedOut: true }>>;
}

export type ClientPresence =
  | { state: "present"; evidence: readonly string[] }
  | { state: "absent" }
  | ({ state: "unavailable" } & ActionableUnavailable);

export type ClientRegistration =
  | { state: "managed"; ownershipEvidence: readonly string[] }
  | { state: "foreign"; conflict: string }
  | { state: "absent" }
  | ({ state: "unavailable" } & ActionableUnavailable);

export interface ClientConfiguration {
  id: string;
  name: string;
  presence: ClientPresence;
  registration: ClientRegistration;
  reloadHint?: string;
}

export interface ClientConfigurationRequest {
  clientId: string;
  desired: "registered" | "disconnected";
}

export interface ClientChangeResult {
  clientId: string;
  desired: ClientConfigurationRequest["desired"];
  outcome: "changed" | "unchanged" | "skipped" | "failed";
  detail?: string;
}

export interface ClientConfigurationPort {
  inspect(context: OperationContext): Promise<UiResult<readonly ClientConfiguration[]>>;
  apply(
    changes: readonly ClientConfigurationRequest[],
    context: OperationContext
  ): Promise<UiResult<readonly ClientChangeResult[], { requested: number }>>;
}

export type DaemonHealth = "stopped" | "starting" | "healthy" | "stalled";

export type DaemonSnapshot =
  | { health: "stopped" }
  | { health: "starting"; instanceId: string; protocol: number }
  | { health: "healthy"; instanceId: string; heartbeatMs: number; protocol: number }
  | { health: "stalled"; instanceId: string; heartbeatMs: number; protocol: number };

export interface DaemonPort {
  get(context: OperationContext): Promise<UiResult<DaemonSnapshot>>;
  start(context: OperationContext): Promise<UiResult<DaemonSnapshot>>;
  stop(context: OperationContext): Promise<UiResult<DaemonSnapshot>>;
  restart(context: OperationContext): Promise<UiResult<DaemonSnapshot>>;
  subscribe(listener: (daemon: UiResult<DaemonSnapshot>) => void): () => void;
}

export interface AppPorts {
  session: SessionPort;
  status: StatusPort;
  meetings: MeetingListPort;
  search: SearchPort;
  transcript: TranscriptPort;
  summary: SummaryPort;
  participants: ParticipantsPort;
  recording: RecordingPort;
  auth: AuthPort;
  clients: ClientConfigurationPort;
  daemon: DaemonPort;
}
