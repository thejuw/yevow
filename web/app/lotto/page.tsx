import type { Metadata } from "next";
import LottoPage from "@/components/lotto/LottoPage";

export const metadata: Metadata = {
  title: "LOTTO | Yevow",
  description:
    "RabbitHoleTX forensic lottery audits, split-risk ticket optimization, and expected-value analysis.",
  alternates: {
    canonical: "https://yevow.co/lotto/"
  },
  openGraph: {
    title: "LOTTO | Yevow",
    description:
      "Forensic Texas draw audits, lower-collision ticket sets, and honest expected-value analysis.",
    type: "website",
    url: "https://yevow.co/lotto/"
  }
};

export default function Page() {
  return <LottoPage />;
}
