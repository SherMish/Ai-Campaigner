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
});
