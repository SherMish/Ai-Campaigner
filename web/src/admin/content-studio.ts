export const CAROUSEL_WIDTH = 1080;
export const CAROUSEL_HEIGHT = 1350;
export const MAX_CAROUSEL_SLIDES = 10;

export type TemplateId = "myth" | "signal" | "checklist";
export type SlideLayout =
  | "hook"
  | "myth"
  | "reality"
  | "explain"
  | "signal"
  | "example"
  | "check"
  | "warning"
  | "cta";

export type CarouselSlide = {
  layout: SlideLayout;
  eyebrow: string;
  title: string;
  hookStyle?: TemplateId;
  body?: string;
  accent?: string;
  number?: string;
  footnote?: string;
};

export type ContentField = {
  id: string;
  slideIndex: number;
  label: string;
  hint?: string;
  multiline?: boolean;
  required?: boolean;
  maxLength: number;
};

export type CarouselDraft = {
  name: string;
  values: Record<string, string>;
  images: Record<number, string | undefined>;
};

export type TemplateDefinition = {
  id: TemplateId;
  name: string;
  shortName: string;
  purpose: string;
  fields: readonly ContentField[];
  defaults: Record<string, string>;
  build: (values: Record<string, string>) => CarouselSlide[];
};

export type ValidationIssue = {
  fieldId: string;
  slideIndex: number;
  kind: "required" | "too_long";
};

export type ContentJsonImportErrorCode =
  | "invalid_json"
  | "invalid_shape"
  | "unsupported_template"
  | "unknown_fields"
  | "missing_fields"
  | "non_string_values"
  | "too_long";

export type ContentJsonImportResult =
  | {
      ok: true;
      templateId: TemplateId;
      name: string;
      values: Record<string, string>;
    }
  | {
      ok: false;
      code: ContentJsonImportErrorCode;
      fields: string[];
    };

const f = (
  id: string,
  slideIndex: number,
  label: string,
  maxLength: number,
  options: Partial<Pick<ContentField, "hint" | "multiline" | "required">> = {},
): ContentField => ({ id, slideIndex, label, maxLength, required: true, ...options });

const copy = strings.he.contentStudio.templates;
const mythCopy = copy.myth;
const signalCopy = copy.signal;
const checklistCopy = copy.checklist;

const myth: TemplateDefinition = {
  id: "myth",
  name: mythCopy.name,
  shortName: mythCopy.shortName,
  purpose: mythCopy.purpose,
  fields: [
    f("hook", 0, mythCopy.fields.hook, 82, { multiline: true }),
    f("myth", 1, mythCopy.fields.myth, 105, { multiline: true }),
    f("why", 2, mythCopy.fields.why, 165, { multiline: true }),
    f("truth", 3, mythCopy.fields.truth, 170, { multiline: true }),
    f("rule", 4, mythCopy.fields.rule, 105, { multiline: true }),
    f("ruleBody", 4, mythCopy.fields.ruleBody, 150, { multiline: true }),
    f("ctaTitle", 5, mythCopy.fields.ctaTitle, 92, { multiline: true }),
    f("ctaBody", 5, mythCopy.fields.ctaBody, 155, { multiline: true }),
  ],
  defaults: mythCopy.defaults,
  build: (v) => [
    { layout: "hook", hookStyle: "myth", eyebrow: "", title: v.hook, accent: mythCopy.slides.hookAccent },
    { layout: "myth", eyebrow: mythCopy.slides.mythEyebrow, title: v.myth, accent: mythCopy.slides.mythAccent },
    { layout: "explain", eyebrow: mythCopy.slides.whyEyebrow, title: mythCopy.slides.whyTitle, body: v.why },
    { layout: "reality", eyebrow: mythCopy.slides.truthEyebrow, title: mythCopy.slides.truthTitle, body: v.truth },
    { layout: "check", eyebrow: mythCopy.slides.ruleEyebrow, title: v.rule, body: v.ruleBody, number: "01" },
    { layout: "cta", eyebrow: copy.shared.ctaEyebrow, title: v.ctaTitle, body: v.ctaBody, accent: mythCopy.slides.ctaAccent },
  ],
};

const signal: TemplateDefinition = {
  id: "signal",
  name: signalCopy.name,
  shortName: signalCopy.shortName,
  purpose: signalCopy.purpose,
  fields: [
    f("hook", 0, signalCopy.fields.hook, 80, { multiline: true }),
    f("bigNumber", 1, signalCopy.fields.bigNumber, 18),
    f("fact", 1, signalCopy.fields.fact, 115, { multiline: true }),
    f("context", 2, signalCopy.fields.context, 175, { multiline: true }),
    f("example", 3, signalCopy.fields.example, 175, { multiline: true }),
    f("action", 4, signalCopy.fields.action, 155, { multiline: true }),
    f("source", 4, signalCopy.fields.source, 110, { required: false, hint: signalCopy.sourceHint }),
    f("ctaTitle", 5, signalCopy.fields.ctaTitle, 92, { multiline: true }),
    f("ctaBody", 5, signalCopy.fields.ctaBody, 155, { multiline: true }),
  ],
  defaults: signalCopy.defaults,
  build: (v) => [
    { layout: "hook", hookStyle: "signal", eyebrow: "", title: v.hook, accent: signalCopy.slides.hookAccent },
    { layout: "signal", eyebrow: signalCopy.slides.signalEyebrow, title: v.bigNumber, body: v.fact },
    { layout: "explain", eyebrow: signalCopy.slides.contextEyebrow, title: signalCopy.slides.contextTitle, body: v.context },
    { layout: "example", eyebrow: signalCopy.slides.exampleEyebrow, title: signalCopy.slides.exampleTitle, body: v.example },
    { layout: "check", eyebrow: signalCopy.slides.actionEyebrow, title: signalCopy.slides.actionTitle, body: v.action, footnote: v.source, number: "✓" },
    { layout: "cta", eyebrow: copy.shared.ctaEyebrow, title: v.ctaTitle, body: v.ctaBody, accent: signalCopy.slides.ctaAccent },
  ],
};

const checklist: TemplateDefinition = {
  id: "checklist",
  name: checklistCopy.name,
  shortName: checklistCopy.shortName,
  purpose: checklistCopy.purpose,
  fields: [
    f("hook", 0, checklistCopy.fields.hook, 82, { multiline: true }),
    f("check1Title", 1, checklistCopy.fields.check1Title, 52),
    f("check1Body", 1, checklistCopy.fields.check1Body, 125, { multiline: true }),
    f("check2Title", 2, checklistCopy.fields.check2Title, 52),
    f("check2Body", 2, checklistCopy.fields.check2Body, 125, { multiline: true }),
    f("check3Title", 3, checklistCopy.fields.check3Title, 52),
    f("check3Body", 3, checklistCopy.fields.check3Body, 125, { multiline: true }),
    f("warning", 4, checklistCopy.fields.warning, 155, { multiline: true }),
    f("ctaTitle", 5, checklistCopy.fields.ctaTitle, 92, { multiline: true }),
    f("ctaBody", 5, checklistCopy.fields.ctaBody, 155, { multiline: true }),
  ],
  defaults: checklistCopy.defaults,
  build: (v) => [
    { layout: "hook", hookStyle: "checklist", eyebrow: "", title: v.hook, accent: checklistCopy.slides.hookAccent },
    { layout: "check", eyebrow: checklistCopy.slides.check1Eyebrow, title: v.check1Title, body: v.check1Body, number: "01" },
    { layout: "check", eyebrow: checklistCopy.slides.check2Eyebrow, title: v.check2Title, body: v.check2Body, number: "02" },
    { layout: "check", eyebrow: checklistCopy.slides.check3Eyebrow, title: v.check3Title, body: v.check3Body, number: "03" },
    { layout: "warning", eyebrow: checklistCopy.slides.warningEyebrow, title: checklistCopy.slides.warningTitle, body: v.warning },
    { layout: "cta", eyebrow: copy.shared.ctaEyebrow, title: v.ctaTitle, body: v.ctaBody, accent: checklistCopy.slides.ctaAccent },
  ],
};

export const CONTENT_TEMPLATES: readonly TemplateDefinition[] = [myth, signal, checklist];

export function getTemplate(id: TemplateId): TemplateDefinition {
  const template = CONTENT_TEMPLATES.find((candidate) => candidate.id === id);
  if (!template) throw new Error(`Unknown template: ${id}`);
  return template;
}

export function createDraft(templateId: TemplateId): CarouselDraft {
  const template = getTemplate(templateId);
  return {
    name: template.shortName,
    values: { ...template.defaults },
    images: {},
  };
}

export function buildSlides(templateId: TemplateId, draft: CarouselDraft): CarouselSlide[] {
  const slides = getTemplate(templateId).build(draft.values);
  if (slides.length > MAX_CAROUSEL_SLIDES) throw new Error("Carousel exceeds Instagram's 10-slide limit");
  if (slides[0]?.layout !== "hook") throw new Error("Every carousel must start with a hook");
  if (slides.at(-1)?.layout !== "cta") throw new Error("Every carousel must end with a CTA");
  return slides;
}

export function validateDraft(templateId: TemplateId, draft: CarouselDraft): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const field of getTemplate(templateId).fields) {
    const value = (draft.values[field.id] ?? "").trim();
    if (field.required && !value) issues.push({ fieldId: field.id, slideIndex: field.slideIndex, kind: "required" });
    else if (value.length > field.maxLength) issues.push({ fieldId: field.id, slideIndex: field.slideIndex, kind: "too_long" });
  }
  return issues;
}

export function jsonTemplate(templateId: TemplateId): string {
  const template = getTemplate(templateId);
  const contract: Record<string, string> = {
    template: templateId,
    name: `<${strings.he.contentStudio.carouselName}>`,
  };
  for (const field of template.fields) {
    contract[field.id] = field.required === false ? "" : `<${field.label}>`;
  }
  return JSON.stringify(contract, null, 2);
}

function jsonError(code: ContentJsonImportErrorCode, fields: string[] = []): ContentJsonImportResult {
  return { ok: false, code, fields };
}

export function importContentJson(raw: string): ContentJsonImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return jsonError("invalid_json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return jsonError("invalid_shape");

  const source = parsed as Record<string, unknown>;
  const templateId = source.template;
  if (templateId !== "myth" && templateId !== "signal" && templateId !== "checklist") {
    return jsonError("unsupported_template", ["template"]);
  }

  const template = getTemplate(templateId);
  const allowed = new Set(["template", "name", ...template.fields.map((field) => field.id)]);
  const unknown = Object.keys(source).filter((key) => !allowed.has(key));
  if (unknown.length) return jsonError("unknown_fields", unknown);

  const stringFields = ["name", ...template.fields.filter((field) => source[field.id] !== undefined).map((field) => field.id)];
  const nonStrings = stringFields.filter((field) => typeof source[field] !== "string");
  if (nonStrings.length) return jsonError("non_string_values", nonStrings);

  const missing = [
    ...(typeof source.name === "string" && source.name.trim() ? [] : ["name"]),
    ...template.fields
      .filter((field) => field.required !== false)
      .filter((field) => typeof source[field.id] !== "string" || !(source[field.id] as string).trim())
      .map((field) => field.id),
  ];
  if (missing.length) return jsonError("missing_fields", missing);

  const values: Record<string, string> = {};
  for (const field of template.fields) {
    const value = source[field.id];
    values[field.id] = typeof value === "string" ? value : "";
  }
  const candidate: CarouselDraft = { name: source.name as string, values, images: {} };
  const tooLong = validateDraft(templateId, candidate)
    .filter((issue) => issue.kind === "too_long")
    .map((issue) => issue.fieldId);
  if (tooLong.length) return jsonError("too_long", tooLong);

  return {
    ok: true,
    templateId,
    name: (source.name as string).trim(),
    values,
  };
}

export function exportFilename(name: string, index: number): string {
  const slug = name
    .trim()
    .toLocaleLowerCase("he-IL")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "") || "carousel";
  return `ads-agent-${slug}-${String(index + 1).padStart(2, "0")}.png`;
}
import { strings } from "../strings.js";
