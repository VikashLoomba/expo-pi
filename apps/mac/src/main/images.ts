import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createPhotonImages } from '@earendil-works/pi-durable/images';
import { PATHS } from 'electrobun/main';

/**
 * pi-durable's image processor over Photon, whose WebAssembly `build.copy` places among the app's resources: a
 * single-file bundle cannot resolve the package, so the main process reads its own copy and calls
 * `createPhotonImages()`, as `@earendil-works/pi-durable/images/node` says. Images are prepared on this thread.
 */
export async function openImages() {
  return createPhotonImages(await readFile(join(PATHS.RESOURCES_FOLDER, 'app', 'photon', 'photon_rs_bg.wasm')));
}
