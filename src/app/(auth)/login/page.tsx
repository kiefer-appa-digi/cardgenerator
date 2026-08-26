import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/current";
import { BrandLogo } from "@/components/brand-logo";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const user = await getCurrentUser();
  if (user) redirect("/");
  const params = await searchParams;
  const next = typeof params.next === "string" ? params.next : "/";

  return (
    <main className="grid min-h-screen lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
      <div className="flex flex-col justify-center px-6 py-12 sm:px-12 lg:px-16">
        <div className="mx-auto w-full max-w-sm">
          <BrandLogo variant="full-color" className="h-10 w-auto" />
          <h1 className="mt-10 font-display text-2xl font-bold tracking-tight text-ink-50">
            Card Designer
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-ink-300">
            Packaging artwork for clamshell insert cards — dielines, product data,
            GS1 barcodes, preflight and press-ready PDF.
          </p>
          <LoginForm next={next} />
          <p className="mt-10 text-xs leading-relaxed text-ink-500">
            Access is logged. Artwork approved in this system is treated as a
            production record.
          </p>
        </div>
      </div>

      <aside className="relative hidden overflow-hidden border-l border-ink-800 bg-ink-950 lg:block">
        <DielinePlate />
      </aside>
    </main>
  );
}

/**
 * A quiet, honest hero: the three real dielines drawn to relative scale with
 * their real cavity footprints. It tells a returning operator exactly what this
 * tool is for, and it is generated from the same preset data the editor uses
 * rather than being a decorative picture that could drift out of date.
 */
function DielinePlate() {
  const cards = [
    { code: "409TF", w: 4.6175, h: 7.36175, cav: [0.4267, 0.9158, 3.7655, 6.194] },
    { code: "277TF", w: 4.593, h: 6.0375, cav: [0.2189, 1.2316, 4.1552, 4.5527] },
    { code: "206TF", w: 3.3675, h: 6.7275, cav: [0.2897, 1.2245, 2.7818, 5.1088] },
  ];
  const gap = 0.55;
  const totalW = cards.reduce((s, c) => s + c.w, 0) + gap * (cards.length - 1);
  const maxH = Math.max(...cards.map((c) => c.h));
  let x = 0;
  const placed = cards.map((c) => {
    const px = x;
    x += c.w + gap;
    return { ...c, x: px, y: (maxH - c.h) / 2 };
  });

  return (
    <svg
      viewBox={`-0.6 -0.6 ${totalW + 1.2} ${maxH + 1.2}`}
      className="absolute inset-0 h-full w-full p-16"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden
    >
      <defs>
        <pattern id="grid" width="0.25" height="0.25" patternUnits="userSpaceOnUse">
          <path d="M0.25 0 L0 0 0 0.25" fill="none" stroke="#1c2026" strokeWidth="0.006" />
        </pattern>
      </defs>
      <rect x="-1" y="-1" width={totalW + 2} height={maxH + 2} fill="url(#grid)" />
      {placed.map((c) => (
        <g key={c.code} transform={`translate(${c.x} ${c.y})`}>
          {/* bleed */}
          <rect
            x="0" y="0" width={c.w} height={c.h} rx="0.375"
            fill="#16191d" stroke="#2b3138" strokeWidth="0.008" strokeDasharray="0.05 0.035"
          />
          {/* trim */}
          <rect
            x="0.125" y="0.125" width={c.w - 0.25} height={c.h - 0.25} rx="0.25"
            fill="#101215" stroke="#3fb1e3" strokeWidth="0.012"
          />
          {/* safe */}
          <rect
            x="0.3125" y="0.3125" width={c.w - 0.625} height={c.h - 0.625} rx="0.0625"
            fill="none" stroke="#2b3138" strokeWidth="0.006" strokeDasharray="0.03 0.03"
          />
          {/* cavity */}
          <rect
            x={c.cav[0]} y={c.cav[1]} width={c.cav[2]} height={c.cav[3]} rx="0.3"
            fill="#e8262708" stroke="#e82627" strokeWidth="0.008" strokeDasharray="0.04 0.03"
          />
          <text
            x={c.w / 2} y={-0.22}
            textAnchor="middle" fill="#939eaa"
            style={{ font: "700 0.18px Archivo, sans-serif", letterSpacing: "0.03px" }}
          >
            {c.code}
          </text>
          <text
            x={c.w / 2} y={c.h + 0.3}
            textAnchor="middle" fill="#4e5762"
            style={{ font: "400 0.13px Inter, sans-serif" }}
          >
            {`${(c.w - 0.25).toFixed(4)} × ${(c.h - 0.25).toFixed(5).replace(/0$/, "")} in`}
          </text>
        </g>
      ))}
    </svg>
  );
}
