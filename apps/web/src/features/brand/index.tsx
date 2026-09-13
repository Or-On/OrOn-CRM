import { product } from "../../branding";
import { BrandMark } from "./mark";

export { EntryStory } from "./entry-story";
export { BrandMark } from "./mark";

export function BrandLockup({
  className = "",
  descriptor,
  markSize = 36,
}: {
  readonly className?: string;
  readonly descriptor?: string;
  readonly markSize?: number;
}) {
  return (
    <span className={`brand-lockup ${className}`.trim()}>
      <BrandMark size={markSize} />
      <span className="brand__copy brand-lockup__copy">
        <span className="brand__name">{product.name}</span>
        {descriptor ? <span className="brand__phase">{descriptor}</span> : null}
      </span>
    </span>
  );
}
