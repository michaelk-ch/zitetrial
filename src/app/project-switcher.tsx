"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import styles from "./page.module.css";

export default function ProjectSwitcher({ projects, selected }: {
  projects: string[];
  selected: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <div className={styles.switcher} aria-busy={pending}>
      <label htmlFor="project">Project</label>
      <select
        id="project"
        value={selected}
        disabled={pending || projects.length === 0}
        onChange={(event) => {
          const query = new URLSearchParams({ project: event.target.value });
          startTransition(() => router.push(`/?${query}`, { scroll: false }));
        }}
      >
        {projects.length === 0 && <option value="">No projects available</option>}
        {projects.map((id) => <option key={id} value={id}>{id}</option>)}
      </select>
      <span className={styles.switchStatus} role="status">
        {pending ? "Switching…" : `${projects.length} projects`}
      </span>
    </div>
  );
}
