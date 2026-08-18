import { useNavigate, useParams } from "react-router-dom";
import { Builder } from "../app/Builder";

// AIC-105 Branch A: the exact same guided builder a customer uses for their
// own first campaign (app/Builder.tsx), mounted here for an operator to run
// on a customer's behalf — the step-4 "no campaigns found" case in the
// onboarding wizard. Builder.tsx already does all the real work; this just
// supplies the customerId and where "back"/"done" should go, since neither
// means "/app" for an operator.
export function AdminBuilder() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  if (!id) return null;
  return <Builder customerId={id} onExit={() => nav(`/admin/onboarding/${id}`)} />;
}
