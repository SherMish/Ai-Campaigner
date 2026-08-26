import { describe, expect, it } from "vitest";
import {
  CAROUSEL_HEIGHT,
  CAROUSEL_WIDTH,
  CONTENT_TEMPLATES,
  MAX_CAROUSEL_SLIDES,
  buildSlides,
  createDraft,
  exportFilename,
  getTemplate,
  importContentJson,
  jsonTemplate,
  validateDraft,
  type TemplateId,
} from "./content-studio.js";

const ids: TemplateId[] = ["myth", "signal", "checklist"];

describe("Ads Agent Content Studio (AIC-142)", () => {
  it("ships exactly three editorial formats with distinct purposes", () => {
    expect(CONTENT_TEMPLATES.map((template) => template.id)).toEqual(ids);
    expect(new Set(CONTENT_TEMPLATES.map((template) => template.purpose)).size).toBe(3);
  });

  it.each(ids)("%s starts with a hook and ends with a CTA", (id) => {
    const slides = buildSlides(id, createDraft(id));
    expect(slides[0].layout).toBe("hook");
    expect(slides.at(-1)?.layout).toBe("cta");
    expect(slides.length).toBeLessThanOrEqual(MAX_CAROUSEL_SLIDES);
  });

  it("gives every format its own hook treatment and no top-right eyebrow", () => {
    const hooks = ids.map((id) => buildSlides(id, createDraft(id))[0] as {
      hookStyle?: string;
      eyebrow?: string;
    });

    expect(new Set(hooks.map((slide) => slide.hookStyle)).size).toBe(3);
    expect(hooks.every((slide) => !slide.eyebrow)).toBe(true);
  });

  it("uses the complete Did-you-know label and keeps the metric slide free of a redundant unit", () => {
    const slides = buildSlides("signal", createDraft("signal"));

    expect(slides[0].accent).toBe("הידעתם?");
    expect(slides[1].accent).toBeUndefined();
  });

  it("keeps the checklist promise aligned with exactly three numbered checks", () => {
    const draft = createDraft("checklist");
    const slides = buildSlides("checklist", draft);

    expect(draft.values.hook).toContain("3 בדיקות");
    expect(slides.filter((slide) => slide.layout === "check")).toHaveLength(3);
    expect(slides).toHaveLength(6);
    expect(getTemplate("checklist").fields.some((field) => field.id.startsWith("check4"))).toBe(false);
  });

  it.each(ids)("%s sample copy is complete and exportable immediately", (id) => {
    expect(validateDraft(id, createDraft(id))).toEqual([]);
  });

  it("pins the Instagram portrait output to 1080×1350", () => {
    expect(CAROUSEL_WIDTH).toBe(1080);
    expect(CAROUSEL_HEIGHT).toBe(1350);
    expect(CAROUSEL_WIDTH / CAROUSEL_HEIGHT).toBe(4 / 5);
  });

  it("blocks a missing required field and points to its real slide", () => {
    const draft = createDraft("myth");
    draft.values.truth = "";
    expect(validateDraft("myth", draft)).toContainEqual({
      fieldId: "truth",
      slideIndex: 3,
      kind: "required",
    });
  });

  it("blocks text beyond the declared safe length instead of silently clipping it", () => {
    const draft = createDraft("signal");
    const field = getTemplate("signal").fields.find((candidate) => candidate.id === "hook")!;
    draft.values.hook = "א".repeat(field.maxLength + 1);
    expect(validateDraft("signal", draft)).toContainEqual({
      fieldId: "hook",
      slideIndex: 0,
      kind: "too_long",
    });
  });

  it("keeps the optional source field optional", () => {
    const draft = createDraft("signal");
    draft.values.source = "";
    expect(validateDraft("signal", draft)).toEqual([]);
  });

  it("uses deterministic, ordered PNG filenames", () => {
    expect(exportFilename("מחיר לפנייה", 0)).toBe("ads-agent-מחיר-לפנייה-01.png");
    expect(exportFilename("מחיר לפנייה", 8)).toBe("ads-agent-מחיר-לפנייה-09.png");
    expect(exportFilename("   ", 0)).toBe("ads-agent-carousel-01.png");
  });

  it.each(ids)("%s exposes a copyable JSON contract with every content field", (id) => {
    const parsed = JSON.parse(jsonTemplate(id)) as Record<string, unknown>;

    expect(parsed.template).toBe(id);
    expect(parsed.name).toBeTypeOf("string");
    for (const field of getTemplate(id).fields) {
      expect(parsed).toHaveProperty(field.id);
      expect(parsed[field.id]).toBeTypeOf("string");
    }
  });

  it("imports a complete JSON string and identifies its target template", () => {
    const source = JSON.parse(jsonTemplate("signal")) as Record<string, string>;
    source.name = "איכות פניות";
    source.hook = "הוק חדש";
    source.bigNumber = "₪31";

    expect(importContentJson(JSON.stringify(source))).toMatchObject({
      ok: true,
      templateId: "signal",
      name: "איכות פניות",
      values: {
        hook: "הוק חדש",
        bigNumber: "₪31",
      },
    });
  });

  it("rejects malformed JSON and missing or misspelled fields instead of partially importing", () => {
    expect(importContentJson("{not-json")).toEqual({ ok: false, code: "invalid_json", fields: [] });

    const source = JSON.parse(jsonTemplate("myth")) as Record<string, string>;
    delete source.truth;
    source.truht = "טעות כתיב";
    expect(importContentJson(JSON.stringify(source))).toEqual({
      ok: false,
      code: "unknown_fields",
      fields: ["truht"],
    });
  });

  it("rejects JSON that would overflow a slide", () => {
    const source = JSON.parse(jsonTemplate("checklist")) as Record<string, string>;
    source.hook = "א".repeat(getTemplate("checklist").fields[0].maxLength + 1);

    expect(importContentJson(JSON.stringify(source))).toEqual({
      ok: false,
      code: "too_long",
      fields: ["hook"],
    });
  });
});
