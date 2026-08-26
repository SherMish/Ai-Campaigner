import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, ImagePlus, Trash2 } from "lucide-react";
import { strings } from "../strings";
import {
  CONTENT_TEMPLATES,
  buildSlides,
  createDraft,
  exportFilename,
  getTemplate,
  validateDraft,
  type CarouselDraft,
  type CarouselSlide,
  type TemplateId,
} from "./content-studio";
import {
  canvasToPng,
  drawCarouselSlide,
  loadCanvasImage,
} from "./content-studio-renderer";
import "./content-studio.css";

const t = strings.he.contentStudio;

const initialDrafts = (): Record<TemplateId, CarouselDraft> => ({
  myth: createDraft("myth"),
  signal: createDraft("signal"),
  checklist: createDraft("checklist"),
});

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("invalid image"));
    reader.onerror = () => reject(reader.error ?? new Error("image read failed"));
    reader.readAsDataURL(file);
  });
}

function SlideCanvas({
  slide,
  index,
  total,
  logo,
  imageSrc,
  className,
}: {
  slide: CarouselSlide;
  index: number;
  total: number;
  logo: HTMLImageElement | null;
  imageSrc?: string;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);

  useEffect(() => {
    let current = true;
    if (!imageSrc) {
      setImage(null);
      return () => { current = false; };
    }
    loadCanvasImage(imageSrc).then((loaded) => current && setImage(loaded)).catch(() => current && setImage(null));
    return () => { current = false; };
  }, [imageSrc]);

  useEffect(() => {
    if (!ref.current) return;
    drawCarouselSlide(ref.current, slide, { index, total, logo, image });
  }, [slide, index, total, logo, image]);

  return <canvas ref={ref} className={className} aria-label={`${t.slide} ${index + 1}`} />;
}

export function AdminContentStudio() {
  const [templateId, setTemplateId] = useState<TemplateId>("myth");
  const [drafts, setDrafts] = useState<Record<TemplateId, CarouselDraft>>(initialDrafts);
  const [selectedSlide, setSelectedSlide] = useState(0);
  const [logo, setLogo] = useState<HTMLImageElement | null>(null);
  const [exporting, setExporting] = useState(false);
  const [status, setStatus] = useState<"ready" | "error" | null>(null);
  const [imageError, setImageError] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const template = getTemplate(templateId);
  const draft = drafts[templateId];
  const slides = useMemo(() => buildSlides(templateId, draft), [templateId, draft]);
  const issues = useMemo(() => validateDraft(templateId, draft), [templateId, draft]);
  const issueByField = useMemo(() => new Map(issues.map((issue) => [issue.fieldId, issue])), [issues]);

  useEffect(() => {
    let current = true;
    Promise.all([
      loadCanvasImage("/favicon.png"),
      document.fonts?.ready ?? Promise.resolve(),
    ]).then(([loaded]) => { if (current) setLogo(loaded); });
    return () => { current = false; };
  }, []);

  function changeTemplate(id: TemplateId) {
    setTemplateId(id);
    setSelectedSlide(0);
    setStatus(null);
    setImageError(false);
  }

  function updateDraft(recipe: (current: CarouselDraft) => CarouselDraft) {
    setDrafts((current) => ({ ...current, [templateId]: recipe(current[templateId]) }));
    setStatus(null);
  }

  function updateValue(fieldId: string, value: string) {
    updateDraft((current) => ({ ...current, values: { ...current.values, [fieldId]: value } }));
  }

  async function chooseImage(file?: File) {
    if (!file) return;
    setImageError(false);
    try {
      const src = await readImage(file);
      updateDraft((current) => ({ ...current, images: { ...current.images, [selectedSlide]: src } }));
    } catch {
      setImageError(true);
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function removeImage() {
    updateDraft((current) => {
      const images = { ...current.images };
      delete images[selectedSlide];
      return { ...current, images };
    });
  }

  async function renderExport(index: number): Promise<HTMLCanvasElement> {
    const canvas = document.createElement("canvas");
    const imageSrc = draft.images[index];
    const image = imageSrc ? await loadCanvasImage(imageSrc) : null;
    drawCarouselSlide(canvas, slides[index], { index, total: slides.length, logo, image });
    return canvas;
  }

  async function exportOne(index: number) {
    if (issues.length || exporting) return;
    setExporting(true);
    setStatus(null);
    try {
      const canvas = await renderExport(index);
      triggerDownload(await canvasToPng(canvas), exportFilename(draft.name, index));
      setStatus("ready");
    } catch {
      setStatus("error");
    } finally {
      setExporting(false);
    }
  }

  async function exportAll() {
    if (issues.length || exporting) return;
    setExporting(true);
    setStatus(null);
    try {
      for (let index = 0; index < slides.length; index += 1) {
        const canvas = await renderExport(index);
        triggerDownload(await canvasToPng(canvas), exportFilename(draft.name, index));
        await new Promise((resolve) => window.setTimeout(resolve, 100));
      }
      setStatus("ready");
    } catch {
      setStatus("error");
    } finally {
      setExporting(false);
    }
  }

  const selectedIsCta = slides[selectedSlide]?.layout === "cta";
  const selectedImage = draft.images[selectedSlide];

  return (
    <div className="wrap page dash content-studio">
      <div className="cs-title-row">
        <div>
          <div className="eyebrow">{t.internalOnly}</div>
          <h1 className="dash-title">{t.title}</h1>
          <p className="muted">{t.subtitle}</p>
        </div>
      </div>

      <section className="cs-template-section" aria-labelledby="cs-template-title">
        <h2 id="cs-template-title">{t.chooseTemplate}</h2>
        <div className="cs-template-grid">
          {CONTENT_TEMPLATES.map((candidate, index) => (
            <button
              type="button"
              key={candidate.id}
              className={`cs-template-card${candidate.id === templateId ? " active" : ""}`}
              onClick={() => changeTemplate(candidate.id)}
            >
              <span className="cs-template-number">0{index + 1}</span>
              <b>{candidate.name}</b>
              <span>{candidate.purpose}</span>
            </button>
          ))}
        </div>
      </section>

      <div className="cs-workspace">
        <section className="card cs-editor" aria-labelledby="cs-editor-title">
          <h2 id="cs-editor-title">{t.editContent}</h2>
          <div className="field cs-name-field">
            <label htmlFor="carousel-name">{t.carouselName}</label>
            <input
              id="carousel-name"
              value={draft.name}
              onChange={(event) => updateDraft((current) => ({ ...current, name: event.target.value }))}
            />
            <small className="muted">{t.carouselNameHint}</small>
          </div>

          {template.fields.map((field) => {
            const value = draft.values[field.id] ?? "";
            const issue = issueByField.get(field.id);
            const inputProps = {
              value,
              maxLength: field.maxLength + 80,
              onFocus: () => setSelectedSlide(field.slideIndex),
              onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => updateValue(field.id, event.target.value),
              "aria-invalid": Boolean(issue),
            };
            return (
              <div className={`field cs-field${issue ? " invalid" : ""}`} key={field.id}>
                <label htmlFor={`cs-${field.id}`}>{field.label}</label>
                {field.multiline ? (
                  <textarea id={`cs-${field.id}`} rows={3} {...inputProps} />
                ) : (
                  <input id={`cs-${field.id}`} {...inputProps} />
                )}
                <div className="cs-field-meta">
                  <span>{field.hint ?? `${t.slide} ${field.slideIndex + 1}`}</span>
                  <span className={value.length > field.maxLength ? "over" : ""}>{value.length}/{field.maxLength} {t.chars}</span>
                </div>
                {issue && <small className="cs-error">{issue.kind === "required" ? t.requiredError : t.tooLongError}</small>}
              </div>
            );
          })}
        </section>

        <aside className="cs-preview-column">
          <section className="card cs-preview-card" aria-labelledby="cs-preview-title">
            <div className="cs-preview-head">
              <div>
                <h2 id="cs-preview-title">{t.preview}</h2>
                <span className="muted">{selectedSlide + 1} / {slides.length}</span>
              </div>
              <div className="cs-preview-nav">
                <button
                  type="button"
                  aria-label={t.previous}
                  disabled={selectedSlide === 0}
                  onClick={() => setSelectedSlide((current) => Math.max(0, current - 1))}
                ><ChevronRight size={20} /></button>
                <button
                  type="button"
                  aria-label={t.next}
                  disabled={selectedSlide === slides.length - 1}
                  onClick={() => setSelectedSlide((current) => Math.min(slides.length - 1, current + 1))}
                ><ChevronLeft size={20} /></button>
              </div>
            </div>

            <SlideCanvas
              slide={slides[selectedSlide]}
              index={selectedSlide}
              total={slides.length}
              logo={logo}
              imageSrc={selectedImage}
              className="cs-main-canvas"
            />

            <div className="cs-thumbnails" role="list">
              {slides.map((slide, index) => (
                <button
                  type="button"
                  role="listitem"
                  key={`${templateId}-${index}`}
                  className={index === selectedSlide ? "active" : ""}
                  onClick={() => setSelectedSlide(index)}
                  aria-label={`${t.slide} ${index + 1}`}
                >
                  <SlideCanvas
                    slide={slide}
                    index={index}
                    total={slides.length}
                    logo={logo}
                    imageSrc={draft.images[index]}
                  />
                  <span>{index + 1}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="card cs-image-card">
            <h3>{t.imageTitle}</h3>
            {selectedIsCta ? (
              <p className="muted">{t.noImageOnCta}</p>
            ) : (
              <>
                <p className="muted">{t.imageHint}</p>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg"
                  hidden
                  onChange={(event) => chooseImage(event.target.files?.[0])}
                />
                <div className="cs-image-actions">
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => fileRef.current?.click()}>
                    <ImagePlus size={17} /> {selectedImage ? t.replaceImage : t.chooseImage}
                  </button>
                  {selectedImage && (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={removeImage}>
                      <Trash2 size={17} /> {t.removeImage}
                    </button>
                  )}
                </div>
              </>
            )}
            {imageError && <p className="cs-error">{t.imageReadError}</p>}
          </section>

          {issues.length > 0 && (
            <div className="cs-validation" role="alert">
              <b>{t.validationTitle}</b>
              <span>{issues.length}</span>
            </div>
          )}

          <div className="cs-export-actions">
            <button type="button" className="btn btn-outline" disabled={issues.length > 0 || exporting} onClick={() => exportOne(selectedSlide)}>
              <Download size={18} /> {exporting ? t.exporting : t.exportCurrent}
            </button>
            <button type="button" className="btn btn-primary" disabled={issues.length > 0 || exporting} onClick={exportAll}>
              <Download size={18} /> {exporting ? t.exporting : t.exportAll}
            </button>
          </div>
          {status === "ready" && <p className="cs-status ok">{t.exportReady}</p>}
          {status === "error" && <p className="cs-status error">{t.exportError}</p>}
        </aside>
      </div>
    </div>
  );
}
