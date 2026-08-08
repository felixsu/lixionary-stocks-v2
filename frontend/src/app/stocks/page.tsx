"use client";

// The sidebar's "Stock analysis" entry: forward to the first favorite's detail
// page, or to the dashboard when there are no favorites yet.

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { useFavorites } from "@/lib/favorites";

export default function StocksIndexPage() {
  const router = useRouter();
  const { favorites } = useFavorites();

  useEffect(() => {
    if (favorites.length > 0) {
      router.replace(`/stocks/${encodeURIComponent(favorites[0])}`);
    } else {
      router.replace("/");
    }
  }, [favorites, router]);

  return null;
}
