/**
 * Browser-only PDF rasterizer shared by local and cloud TeX results.
 *
 * IMPORTANT: load this bundle in the extension ISOLATED world. PDF.js's bundled
 * worker registers pdfjsWorker in this realm, selecting its loopback/fake worker
 * without creating a page-origin or cross-origin Worker. No website global is
 * patched. All PDF.js code and optional standard fonts ship with the extension.
 */
import 'pdfjs-dist/build/pdf.worker.mjs';
import { AnnotationMode, getDocument, type PDFDocumentLoadingTask, type PDFPageProxy, type RenderTask } from 'pdfjs-dist';

const MAX_PDF_BYTES = 8 * 1024 * 1024;
const MAX_SIDE = 2048;
const MAX_PIXELS = 3_000_000;
const MAX_CSS_WIDTH = 900;
const MAX_CSS_HEIGHT = 600;
const TIMEOUT_MS = 15_000;

export interface CloudPdfImage {
  dataUrl: string;
  /** CSS dimensions. Raster resolution can be higher for a crisp popup. */
  width: number;
  height: number;
  diagnostics: string[];
}
export interface CloudPdfRenderOptions { signal?: AbortSignal }

function abortError(message = 'PDF 预览已取消。'): DOMException {
  return new DOMException(message, 'AbortError');
}

function checkCanvasSize(width: number, height: number): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0
    || width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
    throw new Error('PDF 渲染画布超出尺寸上限。');
  }
}

/** Bounds every temporary PDF.js canvas too, not only the final visible page. */
class BoundedCanvasFactory {
  private readonly document: Document;
  constructor({ ownerDocument = document }: { ownerDocument?: Document } = {}) { this.document = ownerDocument; }
  create(width: number, height: number) {
    checkCanvasSize(width, height);
    const canvas = this.document.createElement('canvas'); canvas.width = Math.ceil(width); canvas.height = Math.ceil(height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器无法创建 PDF 预览画布。');
    return { canvas, context };
  }
  reset(target: { canvas: HTMLCanvasElement }, width: number, height: number) {
    checkCanvasSize(width, height); target.canvas.width = Math.ceil(width); target.canvas.height = Math.ceil(height);
  }
  destroy(target: { canvas: HTMLCanvasElement | null; context: CanvasRenderingContext2D | null }) {
    if (target.canvas) { target.canvas.width = 0; target.canvas.height = 0; }
    target.canvas = null; target.context = null;
  }
}

export async function renderCloudPdf(bytes: Uint8Array, options: CloudPdfRenderOptions = {}): Promise<CloudPdfImage> {
  if (!ArrayBuffer.isView(bytes) || Object.prototype.toString.call(bytes) !== '[object Uint8Array]' || !bytes.length || bytes.byteLength > MAX_PDF_BYTES) throw new Error('PDF 为空或超过 8 MiB 上限。');
  if (options.signal?.aborted) throw abortError();
  // Reading header bytes does not execute or parse document actions.
  if (new TextDecoder('ascii').decode(bytes.subarray(0, 1024)).indexOf('%PDF-') < 0) throw new Error('编译返回的内容不是 PDF。');

  let task: PDFDocumentLoadingTask | undefined;
  let page: PDFPageProxy | undefined;
  let renderTask: RenderTask | undefined;
  let canvas: HTMLCanvasElement | undefined;
  let destroyed: Promise<void> | undefined;
  let cancelled: DOMException | undefined;
  let rejectCancellation!: (reason: unknown) => void;
  const cancellation = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
  // The same rejection may race a completed stage; always retain a handler.
  void cancellation.catch(() => {});
  const destroy = () => destroyed ??= task?.destroy().catch(() => {}) ?? Promise.resolve();
  const cancel = (message?: string) => {
    if (cancelled) return;
    cancelled = abortError(message);
    renderTask?.cancel();
    void destroy();
    rejectCancellation(cancelled);
  };
  const onAbort = () => cancel();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => cancel('PDF 预览渲染超时。'), TIMEOUT_MS);
  const guarded = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, cancellation]);

  try {
    const standardFontDataUrl = typeof chrome !== 'undefined' && chrome.runtime?.getURL
      ? chrome.runtime.getURL('pdf-standard-fonts/') : undefined;
    const parameters: Parameters<typeof getDocument>[0] & { isEvalSupported: false } = {
      // Copy because PDF.js can transfer/own the supplied buffer.
      data: bytes.slice(),
      isEvalSupported: false,
      // PDF.js 6 removed isEvalSupported and no longer has that dynamic-code
      // font compilation path. Keep false explicit for compatibility/auditing;
      // do not claim this ignored v6 field is a security mechanism by itself.
      useWasm: false,
      enableXfa: false,
      disableFontFace: true,
      useSystemFonts: false,
      useWorkerFetch: false,
      isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false,
      disableAutoFetch: true,
      disableRange: true,
      disableStream: true,
      stopAtErrors: true,
      maxImageSize: MAX_PIXELS,
      canvasMaxAreaInBytes: MAX_PIXELS * 4,
      CanvasFactory: BoundedCanvasFactory,
      standardFontDataUrl,
      verbosity: 0,
    };
    task = getDocument(parameters);
    // No password prompt or interactive form/JavaScript execution in a popup.
    task.onPassword = () => cancel('PDF 已加密，无法在公式预览中显示。');
    const pdf = await guarded(task.promise);
    if (pdf.numPages !== 1) throw new Error(`公式预览只接受单页 PDF，编译返回了 ${pdf.numPages} 页。`);
    page = await guarded(pdf.getPage(1));
    const natural = page.getViewport({ scale: 96 / 72 });
    if (!Number.isFinite(natural.width) || !Number.isFinite(natural.height) || natural.width <= 0 || natural.height <= 0) throw new Error('PDF 页面尺寸无效。');
    const fit = Math.min(1, MAX_CSS_WIDTH / natural.width, MAX_CSS_HEIGHT / natural.height);
    const width = Math.max(1, Math.ceil(natural.width * fit));
    const height = Math.max(1, Math.ceil(natural.height * fit));
    const density = Math.min(2, Math.max(1, globalThis.devicePixelRatio || 1), MAX_SIDE / width, MAX_SIDE / height, Math.sqrt(MAX_PIXELS / (width * height)));
    const viewport = page.getViewport({ scale: (96 / 72) * fit * density });
    const pixelWidth = Math.ceil(viewport.width), pixelHeight = Math.ceil(viewport.height);
    checkCanvasSize(pixelWidth, pixelHeight);
    canvas = document.createElement('canvas'); canvas.width = pixelWidth; canvas.height = pixelHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器无法创建 PDF 预览画布。');
    renderTask = page.render({ canvas, canvasContext: context, viewport, background: 'rgb(255,255,255)', annotationMode: AnnotationMode.DISABLE });
    await guarded(renderTask.promise);
    if (cancelled) throw cancelled;
    const dataUrl = canvas.toDataURL('image/png');
    if (!dataUrl.startsWith('data:image/png;base64,')) throw new Error('PDF 预览图像生成失败。');
    return { dataUrl, width, height, diagnostics: fit < 1 ? ['公式页面已缩小以适应预览窗口。'] : [] };
  } catch (error) {
    if (cancelled) throw cancelled;
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    try { page?.cleanup(); } catch { /* destroy below is the final cleanup. */ }
    await destroy();
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}
