import { Suspense } from "react";
import Link from "next/link";
import { discoverProjects } from "@/projects/discover";
import ProjectSwitcher from "./project-switcher";
import styles from "./page.module.css";

async function Viewer({ searchParams }: PageProps<"/">) {
  const { project: requested } = await searchParams;
  const projects = await discoverProjects();
  const selected = projects.find((project) => project.id === requested) ?? projects[0];

  return (
    <div className={styles.viewer}>
      <header className={styles.header}>
        <Link href="/" className={styles.brand} aria-label="Zite System Viewer home">
          <span className={styles.brandMark} aria-hidden="true">z</span>
          <span>Zite <span className={styles.brandSecondary}>System Viewer</span></span>
        </Link>
        <ProjectSwitcher projects={projects.map((project) => project.id)} selected={selected?.id ?? ""} />
      </header>
      <main className={styles.main}>
        <div className={styles.projectHeading}>
          <div>
            <p className={styles.eyebrow}>SYSTEM OVERVIEW</p>
            <h1>{selected?.id ?? "Your projects"}</h1>
          </div>
          {selected && <span className={styles.badge}>Local checkout</span>}
        </div>
        <section className={styles.canvas} aria-labelledby="placeholder-title">
          <div className={styles.placeholder}>
            <div className={styles.diagram} aria-hidden="true"><span /><span /><span /></div>
            <p className={styles.eyebrow}>{selected ? "PROJECT READY" : "GET STARTED"}</p>
            <h2 id="placeholder-title">{selected ? "Your system, at a glance" : "No projects yet"}</h2>
            <p>{selected
              ? "Apps, tables, and integrations will come together here. Choose a project above to explore a different system."
              : "Add a repository checkout to userdata/<project>/<sha>, then refresh to see it here."}</p>
          </div>
        </section>
        <p className={styles.footer}>Zite System Visualizer <span>·</span> {selected ? "Visualization coming soon" : "Waiting for a local checkout"}</p>
      </main>
    </div>
  );
}

export default function Home(props: PageProps<"/">) {
  return <Suspense fallback={<p className={styles.main}>Loading projects…</p>}><Viewer {...props} /></Suspense>;
}
