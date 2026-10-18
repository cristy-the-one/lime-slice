/** The live 3D view registers a capture. Saving a project does not import the view. */

let capturePlate: (() => Promise<Uint8Array | null>) | null = null;

export function setPlateThumbnailCapture(capture: () => Promise<Uint8Array | null>) {
  capturePlate = capture;
}

export async function capturePlatePng(): Promise<Uint8Array | null> {
  if (!capturePlate) return null;
  try {
    return await capturePlate();
  } catch {
    return null;
  }
}
