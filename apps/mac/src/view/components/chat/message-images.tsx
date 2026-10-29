import type { ChatImage } from '@pi-agent/infinichat/pi/user-input';

/** The images of a saved message, as the model received them. */
export function MessageImages({ images, size = 180 }: { images: readonly ChatImage[]; size?: number }) {
  return (
    <div className="mb-2 flex flex-wrap gap-2">
      {images.map((image, index) => (
        <img key={index} src={`data:${image.mimeType};base64,${image.data}`} width={size} height={size}
          className="rounded-[10px] object-cover"
          alt={images.length === 1 ? 'Attached image' : `Attached image ${index + 1} of ${images.length}`} />
      ))}
    </div>
  );
}
