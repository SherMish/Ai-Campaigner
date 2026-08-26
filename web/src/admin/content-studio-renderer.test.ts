import { describe, expect, it, vi } from "vitest";
import { drawCarouselSlide } from "./content-studio-renderer.js";
import type { CarouselSlide } from "./content-studio.js";

type TextCall = { text: string; x: number; y: number; maxWidth?: number };

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
      textCalls.push({ text, x, y, maxWidth });
    }),
    drawImage: vi.fn((...args: unknown[]) => imageCalls.push(args)),
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => context),
  } as unknown as HTMLCanvasElement;
  return { canvas, textCalls, imageCalls };
}

describe("Content Studio renderer geometry", () => {
  it("centers a checklist number inside its 176px badge", () => {
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
    expect(number?.x).toBe(94 + 176 / 2);
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
