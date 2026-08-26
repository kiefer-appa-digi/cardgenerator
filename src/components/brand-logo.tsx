import { cn } from "@/lib/cn";

/**
 * The supplied identity package ships full-lockup and mark-only artwork in five
 * colourways. On the dark console the white lockup is the correct one; the
 * full-colour mark is used where the eagle needs to carry the brand alone.
 */
export function BrandLogo({
  variant = "full-white",
  className,
  alt = "Freedom Trailer Parts",
}: {
  variant?: "full-white" | "full-color" | "mark-full-color" | "mark-white";
  className?: string;
  alt?: string;
}) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={`/brand/${variant}.svg`} alt={alt} className={cn("block", className)} />;
}
