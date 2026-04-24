import { themes as prismThemes } from "prism-react-renderer";
import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";

const config: Config = {
  title: "PM Workspace Kit",
  tagline: "Opinionated PM / SA templates, scripts, and playbooks for AI-era product teams",
  favicon: "img/favicon.svg",

  // Replace with your GitHub Pages URL once the repo is public.
  url: "https://hanfourhuang.github.io",
  baseUrl: "/pm-workspace-kit/",

  organizationName: "hanfourhuang",
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

  presets: [
    [
      "classic",
      {
        docs: {
          sidebarPath: "./sidebars.ts",
          editUrl:
            "https://github.com/hanfourhuang/pm-workspace-kit/tree/main/",
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
        { to: "/docs/guides/traceability-matrix", label: "Guides", position: "left" },
        { to: "/docs/handoff/overview", label: "Handoff", position: "left" },
        {
          type: "localeDropdown",
          position: "right",
        },
        {
          href: "https://github.com/hanfourhuang/pm-workspace-kit",
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
              href: "https://github.com/hanfourhuang/pm-workspace-kit",
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
      respectPrefersColorScheme: true,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
