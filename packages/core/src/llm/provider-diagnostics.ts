export type ProviderDiagnosticOutcome =
  | "final-answer"
  | "empty-final"
  | "reasoning-without-final"
  | "incomplete"
  | "policy-block"
  | "provider-error";

export type ContentLengthBucket = "0" | "1-1k" | "1k-10k" | "10k-100k" | "100k+";
export type DurationBucket = "<1s" | "1-5s" | "5-30s" | "30-120s" | "120s+";

export interface ProviderResponseMetadata {
  readonly returnedModel?: string;
  readonly systemFingerprint?: string;
  readonly contentFieldPresent: boolean;
  readonly reasoningFieldPresent: boolean;
  readonly refusalFieldPresent: boolean;
  readonly toolFieldPresent: boolean;
}

export interface ProviderDiagnosticObservation {
  readonly schemaVersion: 1;
  readonly service: string | null;
  readonly requestedModel: string;
  readonly returnedModel?: string;
  readonly systemFingerprint?: string;
  readonly apiFormat: "chat" | "responses";
  readonly stream: boolean;
  readonly providerStage: string | null;
  readonly outcome: ProviderDiagnosticOutcome;
  readonly finishReason: string | null;
  readonly contentLengthBucket: ContentLengthBucket;
  readonly durationBucket: DurationBucket;
  readonly contentFieldPresent: boolean;
  readonly reasoningFieldPresent: boolean;
  readonly refusalFieldPresent: boolean;
  readonly toolFieldPresent: boolean;
  readonly markerPresence: Readonly<Record<string, boolean>>;
  readonly errorClass: string | null;
  readonly errorCode: string | null;
  readonly httpStatus: number | null;
}

export interface ProviderDiagnosticObserver {
  readonly markers?: ReadonlyArray<string>;
  readonly observe: (observation: ProviderDiagnosticObservation) => void;
}

interface DiagnosticResponse {
  readonly content: string;
  readonly finishReason?: string;
  readonly providerMetadata?: ProviderResponseMetadata;
}

interface ProviderDiagnosticBaseInput {
  readonly service: string | null;
  readonly requestedModel: string;
  readonly apiFormat: "chat" | "responses";
  readonly stream: boolean;
  readonly providerStage?: string;
  readonly durationMs: number;
}

export interface ProviderDiagnosticSuccessInput extends ProviderDiagnosticBaseInput {
  readonly response: DiagnosticResponse;
  readonly markers?: ReadonlyArray<string>;
}

export interface ProviderDiagnosticErrorInput extends ProviderDiagnosticBaseInput {
  readonly error: unknown;
}

function bucketContentLength(length: number): ContentLengthBucket {
  if (length <= 0) return "0";
  if (length < 1_000) return "1-1k";
  if (length < 10_000) return "1k-10k";
  if (length < 100_000) return "10k-100k";
  return "100k+";
}

function bucketDuration(durationMs: number): DurationBucket {
  if (durationMs < 1_000) return "<1s";
  if (durationMs < 5_000) return "1-5s";
  if (durationMs < 30_000) return "5-30s";
  if (durationMs < 120_000) return "30-120s";
  return "120s+";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function buildMarkerPresence(
  content: string,
  markers: ReadonlyArray<string> | undefined,
): Readonly<Record<string, boolean>> {
  const entries = (markers ?? [])
    .filter((marker) => marker.trim().length > 0)
    .map((marker) => {
      const normalized = marker.trim();
      const pattern = new RegExp(`^===\\s*${escapeRegExp(normalized)}\\s*===\\s*$`, "mu");
      return [normalized, pattern.test(content)] as const;
    });
  return Object.freeze(Object.fromEntries(entries));
}

function stringProperty(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  const property = (value as Record<string, unknown>)[key];
  return typeof property === "string" && property.length > 0 ? property : null;
}

function numberProperty(value: unknown, key: string): number | null {
  if (!value || typeof value !== "object") return null;
  const property = (value as Record<string, unknown>)[key];
  return typeof property === "number" && Number.isFinite(property) ? property : null;
}

export function buildProviderDiagnosticObservation(
  input: ProviderDiagnosticSuccessInput,
): ProviderDiagnosticObservation {
  const metadata = input.response.providerMetadata;
  return Object.freeze({
    schemaVersion: 1,
    service: input.service,
    requestedModel: input.requestedModel,
    ...(metadata?.returnedModel ? { returnedModel: metadata.returnedModel } : {}),
    ...(metadata?.systemFingerprint ? { systemFingerprint: metadata.systemFingerprint } : {}),
    apiFormat: input.apiFormat,
    stream: input.stream,
    providerStage: input.providerStage ?? null,
    outcome: input.response.content.length > 0 ? "final-answer" : "empty-final",
    finishReason: input.response.finishReason ?? null,
    contentLengthBucket: bucketContentLength(input.response.content.length),
    durationBucket: bucketDuration(input.durationMs),
    contentFieldPresent: metadata?.contentFieldPresent ?? input.response.content.length > 0,
    reasoningFieldPresent: metadata?.reasoningFieldPresent ?? false,
    refusalFieldPresent: metadata?.refusalFieldPresent ?? false,
    toolFieldPresent: metadata?.toolFieldPresent ?? false,
    markerPresence: buildMarkerPresence(input.response.content, input.markers),
    errorClass: null,
    errorCode: null,
    httpStatus: null,
  });
}

export function buildProviderErrorDiagnosticObservation(
  input: ProviderDiagnosticErrorInput,
): ProviderDiagnosticObservation {
  return Object.freeze({
    schemaVersion: 1,
    service: input.service,
    requestedModel: input.requestedModel,
    apiFormat: input.apiFormat,
    stream: input.stream,
    providerStage: input.providerStage ?? null,
    outcome: "provider-error",
    finishReason: null,
    contentLengthBucket: "0",
    durationBucket: bucketDuration(input.durationMs),
    contentFieldPresent: false,
    reasoningFieldPresent: false,
    refusalFieldPresent: false,
    toolFieldPresent: false,
    markerPresence: Object.freeze({}),
    errorClass: stringProperty(input.error, "errorClass"),
    errorCode: stringProperty(input.error, "code"),
    httpStatus: numberProperty(input.error, "status"),
  });
}

export function emitProviderDiagnostic(
  observer: ProviderDiagnosticObserver | undefined,
  observation: ProviderDiagnosticObservation,
): void {
  try {
    observer?.observe(observation);
  } catch {
    // Diagnostics are observational and must never change runtime behavior.
  }
}
