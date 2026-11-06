// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => {
  const destroy = vi.fn(async () => {});
  const cleanup = vi.fn();
  const cancel = vi.fn();
  const render = vi.fn((_parameters: unknown) => ({ promise: Promise.resolve(), cancel }));
  const getViewport = vi.fn(({ scale }: { scale: number }) => ({ width: 120 * scale, height: 36 * scale }));
  const page = { getViewport, render, cleanup };
  const getPage = vi.fn(async () => page);
  const getDocument = vi.fn((_parameters: unknown) => ({ promise: Promise.resolve({ numPages: 1, getPage }), destroy, onPassword: undefined as undefined | (() => void) }));
  return { destroy, cleanup, cancel, render, getViewport, getPage, getDocument };
});
vi.mock('pdfjs-dist', () => ({ AnnotationMode: { DISABLE: 0 }, getDocument: mocked.getDocument }));
vi.mock('pdfjs-dist/build/pdf.worker.mjs', () => ({}));
import { renderCloudPdf } from '../src/preview/cloud-pdf';

const pdfHeader = () => new TextEncoder().encode('%PDF-1.4\nsynthetic test');

beforeEach(() => {
  vi.clearAllMocks();
  mocked.render.mockImplementation(() => ({ promise: Promise.resolve(), cancel: mocked.cancel }));
  mocked.getViewport.mockImplementation(({ scale }) => ({ width: 120 * scale, height: 36 * scale }));
  mocked.getDocument.mockImplementation(() => ({ promise: Promise.resolve({ numPages: 1, getPage: mocked.getPage }), destroy: mocked.destroy, onPassword: undefined }));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,TEST');
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('single-page cloud PDF rasterizer', () => {
  it('uses data-only bounded rendering, returns an image, and destroys resources', async () => {
    const bytes = pdfHeader();
    const image = await renderCloudPdf(bytes);
    expect(image).toEqual({ dataUrl: 'data:image/png;base64,TEST', width: 160, height: 48, diagnostics: [] });
    expect(mocked.getDocument).toHaveBeenCalledWith(expect.objectContaining({
      isEvalSupported: false, useWasm: false, enableXfa: false, disableFontFace: true,
      useWorkerFetch: false, stopAtErrors: true, maxImageSize: 3_000_000,
    }));
    const parameters = mocked.getDocument.mock.calls[0][0] as any;
    expect(parameters.url).toBeUndefined();
    expect(parameters.data).not.toBe(bytes);
    expect(bytes[0]).toBe(37);
    expect(mocked.cleanup).toHaveBeenCalledTimes(1);
    expect(mocked.destroy).toHaveBeenCalledTimes(1);
    expect((mocked.render.mock.calls[0][0] as any).canvas.width).toBe(0);
  });
  it('rejects oversized, invalid, or pre-cancelled inputs before loading', async () => {
    await expect(renderCloudPdf(new Uint8Array(8 * 1024 * 1024 + 1))).rejects.toThrow('8 MiB');
    await expect(renderCloudPdf(new TextEncoder().encode('<html>login</html>'))).rejects.toThrow('不是 PDF');
    const controller = new AbortController(); controller.abort();
    await expect(renderCloudPdf(pdfHeader(), { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocked.getDocument).not.toHaveBeenCalled();
  });
  it('rejects a multi-page PDF and frees its loading task', async () => {
    mocked.getDocument.mockImplementation(() => ({ promise: Promise.resolve({ numPages: 2, getPage: mocked.getPage }), destroy: mocked.destroy, onPassword: undefined }));
    await expect(renderCloudPdf(pdfHeader())).rejects.toThrow('2 页');
    expect(mocked.getPage).not.toHaveBeenCalled();
    expect(mocked.destroy).toHaveBeenCalledTimes(1);
  });
  it('scales large pages to popup dimensions and bounds raster pixels', async () => {
    mocked.getViewport.mockImplementation(({ scale }) => ({ width: 5000 * scale, height: 3000 * scale }));
    const image = await renderCloudPdf(pdfHeader());
    expect(image.width).toBeLessThanOrEqual(900);
    expect(image.height).toBeLessThanOrEqual(600);
    expect(image.diagnostics).toHaveLength(1);
    const viewport = (mocked.render.mock.calls[0][0] as any).viewport;
    expect(viewport.width * viewport.height).toBeLessThanOrEqual(3_000_000);
  });
  it('cancels an in-flight render when its AbortSignal fires', async () => {
    mocked.render.mockImplementation(() => ({ promise: new Promise<void>(() => {}), cancel: mocked.cancel }));
    const controller = new AbortController();
    const result = renderCloudPdf(pdfHeader(), { signal: controller.signal }).catch(error => error);
    await vi.waitFor(() => expect(mocked.render).toHaveBeenCalled());
    controller.abort(); expect(await result).toMatchObject({ name: 'AbortError' });
    expect(mocked.cancel).toHaveBeenCalledTimes(1);
    expect(mocked.destroy).toHaveBeenCalledTimes(1);
  });
  it('times out a stalled renderer and always frees the document', async () => {
    vi.useFakeTimers();
    mocked.render.mockImplementation(() => ({ promise: new Promise<void>(() => {}), cancel: mocked.cancel }));
    const result = renderCloudPdf(pdfHeader()).catch(error => error);
    await vi.advanceTimersByTimeAsync(15_001);
    expect((await result).message).toContain('超时');
    expect(mocked.destroy).toHaveBeenCalledTimes(1);
  });
});
