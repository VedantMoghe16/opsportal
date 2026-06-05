import { redirect } from "next/navigation";

// Blinkit now lives under the Channels hub. Preserve the old URL.
export default function BlinkitPage() {
  redirect("/channels/blinkit");
}
