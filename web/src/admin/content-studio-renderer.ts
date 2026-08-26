import { CAROUSEL_HEIGHT, CAROUSEL_WIDTH, type CarouselSlide } from "./content-studio.js";

export const CONTENT_PALETTE = {
  ink: "#171717",
  cream: "#F7F2EA",
  cream2: "#EDE6DA",
  orange: "#FF5A36",
  green: "#2FA36B",
  indigo: "#665CFF",
  white: "#FFFFFF",
} as const;

type DrawOptions = {
  index: number;
  total: number;
  logo?: HTMLImageElement | null;
  image?: HTMLImageElement | null;
};

type TextOptions = {
  x: number;
  y: number;
  maxWidth: number;
  fontSize: number;
  minFontSize?: number;
  maxLines: number;
  lineHeight?: number;
  weight?: number;
  color: string;
  align?: CanvasTextAlign;
  direction?: CanvasDirection;
};

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function splitLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push("");
      continue;
    }
    let line = words[0];
    for (const word of words.slice(1)) {
      const next = `${line} ${word}`;
      if (ctx.measureText(next).width <= maxWidth) line = next;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

function drawText(ctx: CanvasRenderingContext2D, text: string, options: TextOptions): number {
  const {
    x, y, maxWidth, maxLines, color,
    minFontSize = Math.max(28, options.fontSize - 28),
    weight = 700,
    align = "right",
    direction = "rtl",
  } = options;
  let fontSize = options.fontSize;
  let lines: string[] = [];
  while (fontSize >= minFontSize) {
    ctx.font = `${weight} ${fontSize}px Rubik, Arial, sans-serif`;
    lines = splitLines(ctx, text, maxWidth);
    if (lines.length <= maxLines) break;
    fontSize -= 2;
  }
  const lineHeight = options.lineHeight ?? Math.round(fontSize * 1.17);
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = "top";
  ctx.direction = direction;
  lines.slice(0, maxLines).forEach((line, lineIndex) => ctx.fillText(line, x, y + lineIndex * lineHeight, maxWidth));
  return Math.min(lines.length, maxLines) * lineHeight;
}

function drawEyebrow(ctx: CanvasRenderingContext2D, text: string, color: string, y = 128) {
  ctx.fillStyle = color;
  ctx.font = "600 26px 'IBM Plex Mono', monospace";
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.direction = "rtl";
  ctx.fillText(text, 930, y);
}

function drawProgress(ctx: CanvasRenderingContext2D, index: number, total: number, light = false) {
  ctx.fillStyle = light ? "rgba(247,242,234,.64)" : "rgba(23,23,23,.45)";
  ctx.font = "500 23px 'IBM Plex Mono', monospace";
  ctx.textAlign = "left";
  ctx.direction = "ltr";
  ctx.fillText(`${String(index + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}`, 94, 129);
  const available = 892;
  ctx.fillStyle = light ? "rgba(247,242,234,.18)" : "rgba(23,23,23,.12)";
  ctx.fillRect(94, 1214, available, 6);
  ctx.fillStyle = CONTENT_PALETTE.orange;
  ctx.fillRect(94, 1214, available * ((index + 1) / total), 6);
}

function drawLogo(
  ctx: CanvasRenderingContext2D,
  logo: HTMLImageElement | null | undefined,
  x = 94,
  y = 1227,
  size = 62,
  light = false,
) {
  if (logo) ctx.drawImage(logo, x, y, size, size);
  ctx.fillStyle = light ? CONTENT_PALETTE.cream : CONTENT_PALETTE.ink;
  ctx.font = "700 24px 'IBM Plex Mono', monospace";
  ctx.textAlign = "left";
  ctx.direction = "ltr";
  ctx.textBaseline = "middle";
  ctx.fillText("ADS AGENT", x + size + 14, y + size / 2 + 1);
}

function drawImageCover(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  width: number,
  height: number,
  radius = 34,
) {
  const sourceWidth = image.naturalWidth;
  const sourceHeight = image.naturalHeight;
  const scale = Math.max(width / Number(sourceWidth), height / Number(sourceHeight));
  const cropWidth = width / scale;
  const cropHeight = height / scale;
  const sx = (Number(sourceWidth) - cropWidth) / 2;
  const sy = (Number(sourceHeight) - cropHeight) / 2;
  ctx.save();
  roundedRect(ctx, x, y, width, height, radius);
  ctx.clip();
  ctx.drawImage(image, sx, sy, cropWidth, cropHeight, x, y, width, height);
  ctx.restore();
}

function drawImageLayout(ctx: CanvasRenderingContext2D, slide: CarouselSlide, image: HTMLImageElement, options: DrawOptions) {
  ctx.fillStyle = CONTENT_PALETTE.cream;
  ctx.fillRect(0, 0, CAROUSEL_WIDTH, CAROUSEL_HEIGHT);
  drawEyebrow(ctx, slide.eyebrow.toUpperCase(), CONTENT_PALETTE.orange, 96);
  drawProgress(ctx, options.index, options.total);
  drawImageCover(ctx, image, 94, 180, 892, 510, 38);
  const titleHeight = drawText(ctx, slide.title, {
    x: 930, y: 750, maxWidth: 836, fontSize: 68, minFontSize: 52, maxLines: 3,
    color: CONTENT_PALETTE.ink, weight: 800,
  });
  if (slide.body) drawText(ctx, slide.body, {
    x: 930, y: 750 + titleHeight + 28, maxWidth: 836, fontSize: 36, minFontSize: 31, maxLines: 4,
    color: "rgba(23,23,23,.72)", weight: 400, lineHeight: 49,
  });
  drawLogo(ctx, options.logo);
}

function drawHookImage(ctx: CanvasRenderingContext2D, image: HTMLImageElement, overlay: string) {
  drawImageCover(ctx, image, 0, 0, CAROUSEL_WIDTH, CAROUSEL_HEIGHT, 0);
  ctx.fillStyle = overlay;
  ctx.fillRect(0, 0, CAROUSEL_WIDTH, CAROUSEL_HEIGHT);
}

function drawHookAccent(
  ctx: CanvasRenderingContext2D,
  text: string | undefined,
  right: number,
  y: number,
  background: string,
  color: string,
) {
  if (!text) return;
  ctx.font = "700 28px Rubik, Arial, sans-serif";
  const width = Math.max(150, Math.ceil(ctx.measureText(text).width) + 64);
  const x = right - width;
  ctx.fillStyle = background;
  roundedRect(ctx, x, y, width, 78, 39);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.font = "700 28px Rubik, Arial, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.direction = "rtl";
  ctx.fillText(text, right - 30, y + 78 / 2, width - 60);
}

function drawMythHook(ctx: CanvasRenderingContext2D, slide: CarouselSlide, options: DrawOptions) {
  ctx.fillStyle = CONTENT_PALETTE.ink;
  ctx.fillRect(0, 0, CAROUSEL_WIDTH, CAROUSEL_HEIGHT);
  if (options.image) drawHookImage(ctx, options.image, "rgba(23,23,23,.78)");
  else {
    ctx.save();
    ctx.translate(20, 760);
    ctx.rotate(-0.09);
    ctx.fillStyle = CONTENT_PALETTE.orange;
    roundedRect(ctx, 0, 0, 570, 320, 50);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = CONTENT_PALETTE.indigo;
    ctx.beginPath();
    ctx.arc(90, 1135, 245, 0, Math.PI * 2);
    ctx.fill();
  }
  drawText(ctx, slide.title, {
    x: 930, y: 225, maxWidth: 830, fontSize: 98, minFontSize: 72, maxLines: 5,
    color: CONTENT_PALETTE.cream, weight: 900, lineHeight: 111,
  });
  drawHookAccent(ctx, slide.accent, 986, 1010, CONTENT_PALETTE.orange, CONTENT_PALETTE.white);
  drawProgress(ctx, options.index, options.total, true);
  drawLogo(ctx, options.logo, 94, 1227, 62, true);
}

function drawSignalHook(ctx: CanvasRenderingContext2D, slide: CarouselSlide, options: DrawOptions) {
  ctx.fillStyle = CONTENT_PALETTE.indigo;
  ctx.fillRect(0, 0, CAROUSEL_WIDTH, CAROUSEL_HEIGHT);
  if (options.image) drawHookImage(ctx, options.image, "rgba(73,63,210,.82)");
  ctx.strokeStyle = CONTENT_PALETTE.orange;
  ctx.lineWidth = 22;
  const circleX = 170;
  const circleY = 890;
  ctx.beginPath();
  ctx.arc(circleX, circleY, 245, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "rgba(247,242,234,.09)";
  ctx.beginPath();
  ctx.arc(circleX, circleY, 176, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = CONTENT_PALETTE.orange;
  ctx.font = "900 238px Rubik, Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.direction = "ltr";
  ctx.fillText("?", circleX, circleY);
  drawText(ctx, slide.title, {
    x: 930, y: 230, maxWidth: 810, fontSize: 94, minFontSize: 70, maxLines: 5,
    color: CONTENT_PALETTE.cream, weight: 900, lineHeight: 108,
  });
  drawHookAccent(ctx, slide.accent, 986, 1010, CONTENT_PALETTE.cream, CONTENT_PALETTE.indigo);
  drawProgress(ctx, options.index, options.total, true);
  drawLogo(ctx, options.logo, 94, 1227, 62, true);
}

function drawChecklistHook(ctx: CanvasRenderingContext2D, slide: CarouselSlide, options: DrawOptions) {
  ctx.fillStyle = CONTENT_PALETTE.cream;
  ctx.fillRect(0, 0, CAROUSEL_WIDTH, CAROUSEL_HEIGHT);
  if (options.image) drawHookImage(ctx, options.image, "rgba(247,242,234,.88)");
  const tiles = [
    { x: 94, y: 900, color: CONTENT_PALETTE.ink, text: "01" },
    { x: 230, y: 986, color: CONTENT_PALETTE.orange, text: "02" },
    { x: 366, y: 900, color: CONTENT_PALETTE.green, text: "03" },
  ];
  for (const tile of tiles) {
    ctx.fillStyle = tile.color;
    roundedRect(ctx, tile.x, tile.y, 174, 174, 46);
    ctx.fill();
    drawText(ctx, tile.text, {
      x: tile.x + 87, y: tile.y + 52, maxWidth: 120, fontSize: 58, minFontSize: 58, maxLines: 1,
      color: CONTENT_PALETTE.cream, weight: 900, align: "center", direction: "ltr",
    });
  }
  drawText(ctx, slide.title, {
    x: 930, y: 225, maxWidth: 830, fontSize: 94, minFontSize: 70, maxLines: 5,
    color: CONTENT_PALETTE.ink, weight: 900, lineHeight: 108,
  });
  drawHookAccent(ctx, slide.accent, 986, 1010, CONTENT_PALETTE.orange, CONTENT_PALETTE.white);
  drawProgress(ctx, options.index, options.total);
  drawLogo(ctx, options.logo);
}

function drawHook(ctx: CanvasRenderingContext2D, slide: CarouselSlide, options: DrawOptions) {
  if (slide.hookStyle === "signal") return drawSignalHook(ctx, slide, options);
  if (slide.hookStyle === "checklist") return drawChecklistHook(ctx, slide, options);
  return drawMythHook(ctx, slide, options);
}

function drawMyth(ctx: CanvasRenderingContext2D, slide: CarouselSlide, options: DrawOptions) {
  ctx.fillStyle = CONTENT_PALETTE.orange;
  ctx.fillRect(0, 0, CAROUSEL_WIDTH, CAROUSEL_HEIGHT);
  drawProgress(ctx, options.index, options.total, true);
  ctx.fillStyle = "rgba(23,23,23,.12)";
  ctx.font = "900 410px Rubik, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText("״", 995, 180);
  drawEyebrow(ctx, slide.eyebrow, CONTENT_PALETTE.ink);
  drawText(ctx, slide.title, {
    x: 930, y: 350, maxWidth: 830, fontSize: 86, minFontSize: 66, maxLines: 5,
    color: CONTENT_PALETTE.ink, weight: 900, lineHeight: 102,
  });
  if (slide.accent) {
    ctx.fillStyle = CONTENT_PALETTE.ink;
    roundedRect(ctx, 94, 1036, 330, 92, 46);
    ctx.fill();
    drawText(ctx, slide.accent, {
      x: 386, y: 1061, maxWidth: 255, fontSize: 31, maxLines: 1,
      color: CONTENT_PALETTE.cream, weight: 700,
    });
  }
  drawLogo(ctx, options.logo);
}

function drawContent(ctx: CanvasRenderingContext2D, slide: CarouselSlide, options: DrawOptions) {
  const reality = slide.layout === "reality";
  const example = slide.layout === "example";
  ctx.fillStyle = reality ? CONTENT_PALETTE.indigo : CONTENT_PALETTE.cream;
  ctx.fillRect(0, 0, CAROUSEL_WIDTH, CAROUSEL_HEIGHT);
  drawProgress(ctx, options.index, options.total, reality);
  drawEyebrow(ctx, slide.eyebrow, reality ? CONTENT_PALETTE.cream : CONTENT_PALETTE.orange);

  if (example) {
    ctx.fillStyle = CONTENT_PALETTE.cream2;
    roundedRect(ctx, 94, 275, 892, 725, 48);
    ctx.fill();
  }
  const x = example ? 900 : 930;
  const maxWidth = example ? 760 : 830;
  const titleY = example ? 345 : 300;
  const titleHeight = drawText(ctx, slide.title, {
    x, y: titleY, maxWidth, fontSize: example ? 69 : 78, minFontSize: 58, maxLines: 4,
    color: reality ? CONTENT_PALETTE.cream : CONTENT_PALETTE.ink, weight: 900,
  });
  if (slide.body) drawText(ctx, slide.body, {
    x, y: titleY + titleHeight + 52, maxWidth, fontSize: 39, minFontSize: 32, maxLines: 7,
    color: reality ? "rgba(247,242,234,.82)" : "rgba(23,23,23,.72)", weight: 400, lineHeight: 54,
  });
  drawLogo(ctx, options.logo, 94, 1227, 62, reality);
}

function drawSignal(ctx: CanvasRenderingContext2D, slide: CarouselSlide, options: DrawOptions) {
  ctx.fillStyle = CONTENT_PALETTE.indigo;
  ctx.fillRect(0, 0, CAROUSEL_WIDTH, CAROUSEL_HEIGHT);
  drawProgress(ctx, options.index, options.total, true);
  drawEyebrow(ctx, slide.eyebrow, CONTENT_PALETTE.cream);
  drawText(ctx, slide.title, {
    x: 930, y: 235, maxWidth: 840, fontSize: 210, minFontSize: 132, maxLines: 2,
    color: CONTENT_PALETTE.cream, weight: 900, lineHeight: 210,
  });
  if (slide.accent) drawText(ctx, slide.accent, {
    x: 930, y: 565, maxWidth: 830, fontSize: 42, maxLines: 1,
    color: CONTENT_PALETTE.orange, weight: 700,
  });
  if (slide.body) {
    ctx.fillStyle = "rgba(247,242,234,.1)";
    roundedRect(ctx, 94, 690, 892, 345, 44);
    ctx.fill();
    drawText(ctx, slide.body, {
      x: 916, y: 755, maxWidth: 744, fontSize: 51, minFontSize: 40, maxLines: 5,
      color: CONTENT_PALETTE.cream, weight: 700, lineHeight: 66,
    });
  }
  drawLogo(ctx, options.logo, 94, 1227, 62, true);
}

function drawCheck(ctx: CanvasRenderingContext2D, slide: CarouselSlide, options: DrawOptions) {
  ctx.fillStyle = CONTENT_PALETTE.cream;
  ctx.fillRect(0, 0, CAROUSEL_WIDTH, CAROUSEL_HEIGHT);
  drawProgress(ctx, options.index, options.total);
  drawEyebrow(ctx, slide.eyebrow, CONTENT_PALETTE.orange);
  ctx.fillStyle = CONTENT_PALETTE.ink;
  roundedRect(ctx, 94, 265, 176, 176, 50);
  ctx.fill();
  const badgeMark = slide.number ?? "✓";
  ctx.fillStyle = CONTENT_PALETTE.orange;
  ctx.font = `900 ${badgeMark === "✓" ? 92 : 74}px Rubik, Arial, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.direction = "ltr";
  ctx.fillText(badgeMark, 94 + 176 / 2, 265 + 176 / 2);
  const titleHeight = drawText(ctx, slide.title, {
    x: 930, y: 510, maxWidth: 836, fontSize: 78, minFontSize: 60, maxLines: 4,
    color: CONTENT_PALETTE.ink, weight: 900,
  });
  if (slide.body) drawText(ctx, slide.body, {
    x: 930, y: 510 + titleHeight + 46, maxWidth: 836, fontSize: 39, minFontSize: 32, maxLines: 6,
    color: "rgba(23,23,23,.68)", weight: 400, lineHeight: 54,
  });
  if (slide.footnote) drawText(ctx, slide.footnote, {
    x: 930, y: 1122, maxWidth: 836, fontSize: 24, minFontSize: 21, maxLines: 2,
    color: "rgba(23,23,23,.44)", weight: 400,
  });
  drawLogo(ctx, options.logo);
}

function drawWarning(ctx: CanvasRenderingContext2D, slide: CarouselSlide, options: DrawOptions) {
  ctx.fillStyle = CONTENT_PALETTE.ink;
  ctx.fillRect(0, 0, CAROUSEL_WIDTH, CAROUSEL_HEIGHT);
  drawProgress(ctx, options.index, options.total, true);
  drawEyebrow(ctx, slide.eyebrow, CONTENT_PALETTE.orange);
  ctx.strokeStyle = CONTENT_PALETTE.orange;
  ctx.lineWidth = 18;
  roundedRect(ctx, 94, 265, 892, 700, 56);
  ctx.stroke();
  const titleHeight = drawText(ctx, slide.title, {
    x: 900, y: 340, maxWidth: 730, fontSize: 80, minFontSize: 60, maxLines: 4,
    color: CONTENT_PALETTE.cream, weight: 900,
  });
  if (slide.body) drawText(ctx, slide.body, {
    x: 900, y: 340 + titleHeight + 44, maxWidth: 730, fontSize: 39, minFontSize: 32, maxLines: 6,
    color: "rgba(247,242,234,.76)", weight: 400, lineHeight: 54,
  });
  if (slide.accent) {
    ctx.fillStyle = CONTENT_PALETTE.orange;
    roundedRect(ctx, 656, 1012, 330, 82, 41);
    ctx.fill();
    drawText(ctx, slide.accent, {
      x: 946, y: 1035, maxWidth: 250, fontSize: 29, maxLines: 1,
      color: CONTENT_PALETTE.white, weight: 700,
    });
  }
  drawLogo(ctx, options.logo, 94, 1227, 62, true);
}

function drawCta(ctx: CanvasRenderingContext2D, slide: CarouselSlide, options: DrawOptions) {
  ctx.fillStyle = CONTENT_PALETTE.orange;
  ctx.fillRect(0, 0, CAROUSEL_WIDTH, CAROUSEL_HEIGHT);
  ctx.fillStyle = CONTENT_PALETTE.ink;
  ctx.beginPath();
  ctx.arc(-5, 1160, 350, 0, Math.PI * 2);
  ctx.fill();
  drawProgress(ctx, options.index, options.total, true);
  drawEyebrow(ctx, slide.eyebrow, CONTENT_PALETTE.ink);
  const titleHeight = drawText(ctx, slide.title, {
    x: 930, y: 300, maxWidth: 830, fontSize: 86, minFontSize: 60, maxLines: 3,
    color: CONTENT_PALETTE.ink, weight: 900, lineHeight: 99,
  });
  if (slide.body) drawText(ctx, slide.body, {
    x: 930, y: 300 + titleHeight + 44, maxWidth: 560, fontSize: 36, minFontSize: 30, maxLines: 5,
    color: CONTENT_PALETTE.ink, weight: 500, lineHeight: 48,
  });
  if (slide.accent) {
    ctx.fillStyle = CONTENT_PALETTE.cream;
    roundedRect(ctx, 520, 1050, 466, 94, 47);
    ctx.fill();
    drawText(ctx, slide.accent, {
      x: 944, y: 1078, maxWidth: 380, fontSize: 30, minFontSize: 26, maxLines: 1,
      color: CONTENT_PALETTE.ink, weight: 700,
    });
  }
}

export function prepareCarouselCanvas(canvas: HTMLCanvasElement) {
  canvas.width = CAROUSEL_WIDTH;
  canvas.height = CAROUSEL_HEIGHT;
}

export function drawCarouselSlide(
  canvas: HTMLCanvasElement,
  slide: CarouselSlide,
  options: DrawOptions,
) {
  prepareCarouselCanvas(canvas);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is unavailable");
  ctx.clearRect(0, 0, CAROUSEL_WIDTH, CAROUSEL_HEIGHT);

  if (options.image && slide.layout !== "hook" && slide.layout !== "cta") {
    drawImageLayout(ctx, slide, options.image, options);
    return;
  }

  switch (slide.layout) {
    case "hook": drawHook(ctx, slide, options); return;
    case "myth": drawMyth(ctx, slide, options); return;
    case "reality":
    case "explain":
    case "example": drawContent(ctx, slide, options); return;
    case "signal": drawSignal(ctx, slide, options); return;
    case "check": drawCheck(ctx, slide, options); return;
    case "warning": drawWarning(ctx, slide, options); return;
    case "cta": drawCta(ctx, slide, options); return;
  }
}

export function loadCanvasImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Image could not be loaded"));
    image.src = src;
  });
}

export function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("PNG export failed")), "image/png", 1);
  });
}
