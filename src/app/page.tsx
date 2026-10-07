import styles from "./page.module.css";

export default function Home() {
  return (
    <main className={styles.main}>
      <p className={styles.eyebrow}>NEXT.JS + TYPESCRIPT</p>
      <h1>Zitetrial</h1>
      <p>Your project is ready. Start building in <code>src/app/page.tsx</code>.</p>
    </main>
  );
}
