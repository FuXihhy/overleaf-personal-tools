/** Transport replacement used only by the local development build. It cannot
 * reach Overleaf or create cloud projects; production origin checks stay strict.
 */
export class OverleafCloudClient {
  constructor(readonly sourceProjectId: string) {}
  getPreviewProject() { return undefined; }
  restorePreviewProject() {}
  async createPreviewProject() { throw new Error('Cloud compilation is unavailable in the local synthetic fixture.'); }
  getFiles() { return []; }
  async refreshMetadata() { throw new Error('Cloud compilation is unavailable in the local synthetic fixture.'); }
  async removeManagedFiles() { throw new Error('Cloud compilation is unavailable in the local synthetic fixture.'); }
  async setCompiler() { throw new Error('Cloud compilation is unavailable in the local synthetic fixture.'); }
  async uploadText() { throw new Error('Cloud compilation is unavailable in the local synthetic fixture.'); }
  async compile() { throw new Error('Cloud compilation is unavailable in the local synthetic fixture.'); }
}
