import Link from "@docusaurus/Link";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import Layout from "@theme/Layout";
import Translate, { translate } from "@docusaurus/Translate";
import clsx from "clsx";
import type { JSX } from "react";

import styles from "./index.module.css";

function Hero() {
  const { siteConfig } = useDocusaurusContext();
  return (
    <header className={clsx("hero hero--primary", styles.hero)}>
      <div className="container">
        <h1 className="hero__title">{siteConfig.title}</h1>
        <p className="hero__subtitle">
          <Translate
            id="homepage.tagline"
            description="Hero tagline on the homepage"
          >
            Opinionated PM / SA templates, scripts, and playbooks for AI-era
            product teams.
          </Translate>
        </p>
        <div className={styles.buttons}>
          <Link className="button button--primary button--lg" to="/docs/intro">
            <Translate id="homepage.ctaPrimary">Read the docs</Translate>
          </Link>
          <Link
            className="button button--secondary button--lg"
            to="/docs/getting-started"
          >
            <Translate id="homepage.ctaSecondary">
              Get started in 10 min
            </Translate>
          </Link>
        </div>
      </div>
    </header>
  );
}

function Features() {
  return (
    <section className={styles.features}>
      <div className="container">
        <div className="row">
          <div className={clsx("col col--6", styles.feature)}>
            <h3>
              <Translate id="homepage.feature1.title">
                Traceability with teeth
              </Translate>
            </h3>
            <p>
              <Translate id="homepage.feature1.body">
                Front-matter on every PRD, spec and plan. A check step in CI
                that fails the PR if the link is broken, plus a Mermaid
                dependency graph auto-regenerated from the same source.
              </Translate>
            </p>
          </div>
          <div className={clsx("col col--6", styles.feature)}>
            <h3>
              <Translate id="homepage.feature2.title">
                Methodology ADRs
              </Translate>
            </h3>
            <p>
              <Translate id="homepage.feature2.body">
                Strangler Fig protocol, Dev Harness conventions, Product
                Decision Log — three ready-to-adopt records for the parts of
                your stack that matter most on day 200, not day 2.
              </Translate>
            </p>
          </div>
          <div className={clsx("col col--6", styles.feature)}>
            <h3>
              <Translate id="homepage.feature3.title">Handoff-ready</Translate>
            </h3>
            <p>
              <Translate id="homepage.feature3.body">
                PR template, code-review checklist, module runbook, monitoring
                dashboard spec, readiness checklist. The engineering team
                inherits a playbook, not a wiki spelunking exercise.
              </Translate>
            </p>
          </div>
          <div className={clsx("col col--6", styles.feature)}>
            <h3>
              <Translate id="homepage.feature4.title">
                AI-native workflow
              </Translate>
            </h3>
            <p>
              <Translate id="homepage.feature4.body">
                Skills and commands tuned for Claude Code: requirement intake,
                PRD generation, Confluence publishing with status-label sync.
                Opt-in; the kit works with or without them.
              </Translate>
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

export default function Home(): JSX.Element {
  return (
    <Layout
      title={translate({
        id: "homepage.title",
        message: "PM Workspace Kit",
      })}
      description="An opinionated PM / SA workspace kit."
    >
      <Hero />
      <main>
        <Features />
      </main>
    </Layout>
  );
}
