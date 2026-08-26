import { describe, expect, it, vi } from "vitest";
import { drawCarouselSlide } from "./content-studio-renderer.js";
import type { CarouselSlide } from "./content-studio.js";

type TextCall = {
  text: string;
  x: number;
  y: number;
  maxWidth?: number;
  align: string;
  baseline: string;
};

function fakeCanvas() {
  const textCalls: TextCall[] = [];
  const imageCalls: unknown[][] = [];
  const context = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    font: "",
    textAlign: "start",
    textBaseline: "top",
    direction: "inherit",
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    arcTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    clip: vi.fn(),
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    measureText: vi.fn((text: string) => ({ width: text.length * 20 })),
    fillText: vi.fn((text: string, x: number, y: number, maxWidth?: number) => {
      textCalls.push({
        text,
        x,
        y,
        maxWidth,
        align: context.textAlign,
        baseline: context.textBaseline,
      });
    }),
    drawImage: vi.fn((...args: unknown[]) => imageCalls.push(args)),
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => context),
  } as unknown as HTMLCanvasElement;
  return { canvas, context, textCalls, imageCalls };
}

describe("Content Studio renderer geometry", () => {
  it("centers a checklist number inside a right-aligned 176px badge", () => {
    const { canvas, textCalls } = fakeCanvas();
    const slide: CarouselSlide = {
      layout: "check",
      eyebrow: "check",
      title: "title",
      body: "body",
      number: "01",
    };

    drawCarouselSlide(canvas, slide, { index: 1, total: 7 });

    const number = textCalls.find((call) => call.text === "01");
    expect(number).toMatchObject({
      x: 810 + 176 / 2,
      y: 265 + 176 / 2,
      align: "center",
      baseline: "middle",
    });
  });

  it("centers the check mark inside the same badge geometry", () => {
    const { canvas, textCalls } = fakeCanvas();
    const slide: CarouselSlide = {
      layout: "check",
      eyebrow: "check",
      title: "title",
      body: "body",
      number: "✓",
    };

    drawCarouselSlide(canvas, slide, { index: 4, total: 6 });

    expect(textCalls.find((call) => call.text === "✓")).toMatchObject({
      x: 810 + 176 / 2,
      y: 265 + 176 / 2,
      align: "center",
      baseline: "middle",
    });
  });

  it.each(["myth", "explain", "signal", "check", "warning", "cta"] as const)(
    "does not render the top-right eyebrow on %s slides",
    (layout) => {
      const { canvas, textCalls } = fakeCanvas();
      const slide: CarouselSlide = {
        layout,
        eyebrow: "SMALL TOP TITLE",
        title: "title",
        body: "body",
        number: layout === "check" ? "01" : undefined,
      };

      drawCarouselSlide(canvas, slide, { index: 1, total: 6 });

      expect(textCalls.some((call) => call.text === "SMALL TOP TITLE")).toBe(false);
    },
  );

  it("centers the signal question and keeps its circle clear of the footer", () => {
    const { canvas, context, textCalls } = fakeCanvas();
    const slide: CarouselSlide = {
      layout: "hook",
      hookStyle: "signal",
      eyebrow: "",
      title: "title",
      accent: "הידעתם?",
    };

    drawCarouselSlide(canvas, slide, { index: 0, total: 6 });

    const outerCircle = context.arc.mock.calls[0] as [number, number, number];
    const question = textCalls.find((call) => call.text === "?");
    expect(question).toMatchObject({
      x: outerCircle[0],
      y: outerCircle[1],
      align: "center",
      baseline: "middle",
    });
    expect(outerCircle[1] + outerCircle[2]).toBeLessThan(1214);

    const pillX = context.moveTo.mock.calls[0][0] - 39;
    const pillRight = context.arcTo.mock.calls[0][0];
    expect(pillRight).toBe(986);
    expect(pillRight - pillX).toBe("הידעתם?".length * 20 + 64);
  });

  it("centers checklist hook accent copy vertically inside its pill", () => {
    const { canvas, textCalls } = fakeCanvas();
    const slide: CarouselSlide = {
      layout: "hook",
      hookStyle: "checklist",
      eyebrow: "",
      title: "title",
      accent: "שמרו את הפוסט",
    };

    drawCarouselSlide(canvas, slide, { index: 0, total: 6 });

    expect(textCalls.find((call) => call.text === "שמרו את הפוסט")).toMatchObject({
      y: 1010 + 78 / 2,
      align: "right",
      baseline: "middle",
    });
  });

  it("keeps CTA copy out of the dark decoration and removes the redundant top logo", () => {
    const { canvas, textCalls, imageCalls } = fakeCanvas();
    const slide: CarouselSlide = {
      layout: "cta",
      eyebrow: "ADS AGENT",
      title: "A title",
      body: "Body text that should remain readable",
      accent: "CTA",
    };

    drawCarouselSlide(canvas, slide, {
      index: 6,
      total: 7,
      logo: {} as HTMLImageElement,
    });

    const body = textCalls.find((call) => call.text.includes("Body text"));
    expect(body?.maxWidth).toBeLessThanOrEqual(560);
    expect(imageCalls).toHaveLength(0);
  });
});
