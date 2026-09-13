import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { Nav } from "@/components/Nav";

export const dynamic = "force-dynamic";

/** Shell for every signed-in screen. Guards auth once for the whole group. */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  return (
    <div className="min-h-dvh">
      <Nav userName={session.user.name ?? session.user.email} userImage={session.user.image} />
      {/* Bottom padding clears the mobile tab bar. */}
      <main className="mx-auto max-w-5xl px-4 pb-24 pt-5 sm:px-5 sm:pb-12">{children}</main>
    </div>
  );
}
