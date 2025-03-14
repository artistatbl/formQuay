import type { Metadata } from "next"
import { Providers } from "../components/global/providers"
import { ClerkProvider } from "@clerk/nextjs"

import { cn } from "@/lib/utils"

import "./globals.css"

export const metadata: Metadata = {
  title: "FormsQuay",
  description: "FormsQuay - Your Personalized Forms Platform",
  icons: [{ rel: "icon", url: "/favicon.ico" }],
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <ClerkProvider publishableKey={process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY}>

    <html lang="en">
      <body className="antialiased">
          <Providers>{children}</Providers>
        </body>
      </html>
    </ClerkProvider>
  )
}
