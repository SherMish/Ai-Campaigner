import { assertNever } from "@aic/shared";
import { strings } from "../strings";

// AIC-101 — the onboarding wizard's diagnosis → copy binding, same
// discipline as web/src/app/state-copy.ts (AIC-98): this is exactly the
// shape that house rule exists for. Three failures (not_shared,
// not_assigned, token_missing_scopes) look IDENTICAL from the Business
// Settings UI — that is the entire premise of the ticket — so collapsing
// them into one message here would reproduce the exact failure the wizard
// exists to prevent.
export type AccessDiagnosis =
  | "ok"
  | "not_shared"
  | "not_assigned"
  | "token_missing_scopes"
  | "unreadable_unknown_cause"
  | "unknown";

export interface DiagnosisCopy {
  title: string;
  body: string;
}

const w = strings.he.onboardingWizard;

export const DIAGNOSIS_COPY: Record<AccessDiagnosis, DiagnosisCopy> = {
  ok: w.diagnosisOk,
  not_shared: w.diagnosisNotShared,
  not_assigned: w.diagnosisNotAssigned,
  token_missing_scopes: w.diagnosisTokenMissingScopes,
  unreadable_unknown_cause: w.diagnosisUnreadableUnknown,
  unknown: w.diagnosisUnknown,
};

export function diagnosisCopy(d: string): DiagnosisCopy {
  switch (d as AccessDiagnosis) {
    case "ok":
    case "not_shared":
    case "not_assigned":
    case "token_missing_scopes":
    case "unreadable_unknown_cause":
    case "unknown":
      return DIAGNOSIS_COPY[d as AccessDiagnosis];
    default:
      // A diagnosis the server invented that this map doesn't know about —
      // compile-time exhaustiveness can't reach across the HTTP boundary, so
      // this is the runtime half: never render nothing, name the gap.
      return { title: d, body: "" };
  }
}

// Kept reachable so the exhaustiveness guard actually compiles against every
// known case above (mirrors state-copy.ts's use of assertNever in Home.tsx).
export function assertKnownDiagnosis(d: AccessDiagnosis): DiagnosisCopy {
  switch (d) {
    case "ok": return DIAGNOSIS_COPY.ok;
    case "not_shared": return DIAGNOSIS_COPY.not_shared;
    case "not_assigned": return DIAGNOSIS_COPY.not_assigned;
    case "token_missing_scopes": return DIAGNOSIS_COPY.token_missing_scopes;
    case "unreadable_unknown_cause": return DIAGNOSIS_COPY.unreadable_unknown_cause;
    case "unknown": return DIAGNOSIS_COPY.unknown;
    default: return assertNever(d, "AccessDiagnosis");
  }
}
