import { themes as prismThemes } from "prism-react-renderer";
import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";

const config: Config = {
  title: "PM Workspace Kit",
  tagline:
    "Opinionated PM / SA templates, a CLI (pmk), and a Slack gateway for AI-era product teams",
  favicon: "img/favicon.svg",

  // Deployed at https://hanfour.github.io/pm-workspace-kit/ via
  // .github/workflows/deploy.yml on every push to main that touches
  // apps/docs/**.
  url: "https://hanfour.github.io",
  baseUrl: "/pm-workspace-kit/",

  organizationName: "hanfour",
  projectName: "pm-workspace-kit",

  onBrokenLinks: "warn",
  onBrokenMarkdownLinks: "warn",

  i18n: {
    defaultLocale: "en",
    locales: ["en", "zh-TW"],
    localeConfigs: {
      en: { label: "English" },
      "zh-TW": { label: "繁體中文" },
    },
  },

  // Enable Mermaid in markdown so docs can embed flow diagrams.
  // Used by gateway/lifecycle.md (v0.7+).
  markdown: {
    mermaid: true,
  },

  themes: ["@docusaurus/theme-mermaid"],

  presets: [
    [
      "classic",
      {
        docs: {
          sidebarPath: "./sidebars.ts",
          editUrl: "https://github.com/hanfour/pm-workspace-kit/tree/main/",
          showLastUpdateTime: true,
          showLastUpdateAuthor: true,
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: "img/social-card.png",
    navbar: {
      title: "PM Workspace Kit",
      logo: { alt: "Kit logo", src: "img/logo.svg" },
      items: [
        { to: "/docs/intro", label: "Docs", position: "left" },
        {
          to: "/docs/guides/traceability-matrix",
          label: "Guides",
          position: "left",
        },
        { to: "/docs/handoff/overview", label: "Handoff", position: "left" },
        {
          type: "localeDropdown",
          position: "right",
        },
        {
          href: "https://github.com/hanfour/pm-workspace-kit",
          label: "GitHub",
          position: "right",
        },
      ],
    },
    footer: {
      style: "light",
      links: [
        {
          title: "Docs",
          items: [
            { label: "Introduction", to: "/docs/intro" },
            { label: "Getting Started", to: "/docs/getting-started" },
            { label: "Concepts", to: "/docs/concepts/traceability" },
            { label: "Guides", to: "/docs/guides/traceability-matrix" },
          ],
        },
        {
          title: "Kit",
          items: [
            { label: "Handoff", to: "/docs/handoff/overview" },
            { label: "Templates", to: "/docs/templates/adr-template" },
            { label: "Example", to: "/docs/examples/acme-ads" },
          ],
        },
        {
          title: "More",
          items: [
            {
              label: "GitHub",
              href: "https://github.com/hanfour/pm-workspace-kit",
            },
            { label: "License (MIT)", href: "/LICENSE.txt" },
          ],
        },
      ],
      copyright: `MIT Licensed. Copyright © ${new Date().getFullYear()} PM Workspace Kit contributors.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ["bash", "yaml", "json"],
    },
    colorMode: {
      defaultMode: "light",
      // Simple 2-state toggle (light / dark) instead of tri-state.
      // The tri-state cycle light -> dark -> system surprises users
      // because the "system" step looks identical to whichever mode
      // the OS currently prefers, making it feel like the toggle is
      // broken on the third click.
      respectPrefersColorScheme: false,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
