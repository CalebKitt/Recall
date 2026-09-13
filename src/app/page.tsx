import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Entry point: straight to the decks if signed in, otherwise to the login page. */
export default async function Home() {
  const session = await auth();
  redirect(session?.user ? "/decks" : "/login");
}
