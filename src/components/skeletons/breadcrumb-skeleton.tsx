"use client"

import { ChevronRight } from "lucide-react"
import { Skeleton } from "../ui/skeleton"
import { usePathname } from "next/navigation"

export function BreadcrumbSkeleton() {
  const pathname = usePathname()
  const segmentCount = pathname.split("/").filter(Boolean).length

  // Generate an array of segments based on the path length
  const segments = Array.from({ length: segmentCount || 1 }).map((_, index) => {
    // Make the last segment wider to represent the current page
    const isLast = index === segmentCount - 1
    const width = isLast ? "w-24" : "w-16"
    
    return (
      <div key={index} className="flex items-center">
        {index > 0 && <ChevronRight className="mx-1.5 h-3 w-3 text-gray-500" />}
        <Skeleton className={`h-4 ${width} bg-gray-700/50 dark:bg-zinc-800/50 rounded-md`} />
      </div>
    )
  })

  return (
    <div className="flex items-center">
      {segments}
    </div>
  )
} 