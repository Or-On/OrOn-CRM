import Image from "next/image";
import type { CSSProperties } from "react";

import { product } from "../../branding";

interface BrandMarkProps {
  readonly className?: string;
  readonly size?: number;
}

/** Canonical Or-On product mark supplied by the product owner. */
export function BrandMark({ className = "", size = 36 }: BrandMarkProps) {
  const style = { "--brand-mark-size": `${String(size)}px` } as CSSProperties;
  return (
    <Image
      alt=""
      aria-hidden="true"
      className={`brand__mark product-logo ${className}`.trim()}
      draggable={false}
      height={size}
      src={product.logoPath}
      style={style}
      unoptimized
      width={size}
    />
  );
}
