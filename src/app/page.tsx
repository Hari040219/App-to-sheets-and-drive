"use client";

import dynamic from "next/dynamic";

const FoApp = dynamic(() => import("@/components/FoApp"), {
  ssr: false,
  loading: () => <main className="app" aria-busy="true" />,
});

export default function Home() {
  return <FoApp />;
}
