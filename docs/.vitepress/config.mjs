import { defineConfig } from 'vitepress'

/** Public site origin; used for the sitemap and the canonical link of each page. */
const SITE_ORIGIN = 'https://ipfs-node.docs.adamant.im'

/** Default branch of the source repository, used by the edit-on-GitHub links. */
const REPOSITORY_BRANCH = 'dev'

export default defineConfig({
  lang: 'en-US',
  title: 'ADAMANT IPFS Node',
  description:
    'Self-hosted IPFS storage node for application file delivery, with bounded disk usage, ' +
    'deterministic replication, repair, health checkpoints, and a REST API.',
  cleanUrls: true,
  lastUpdated: true,
  metaChunk: true,

  // A broken internal link is a documentation defect, so the build fails on one
  // instead of publishing a page that leads nowhere.
  ignoreDeadLinks: false,

  sitemap: {
    hostname: SITE_ORIGIN
  },

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    ['meta', { name: 'theme-color', content: '#0e7490' }],
    ['meta', { name: 'author', content: 'ADAMANT Foundation' }]
  ],

  /**
   * Add a canonical URL and Open Graph metadata per page.
   *
   * No analytics, telemetry, or third-party runtime script is added here on
   * purpose: the site loads nothing that is not served from its own origin.
   *
   * @param pageData Page currently being rendered
   */
  transformPageData(pageData) {
    const path = pageData.relativePath.replace(/((^|\/)index)?\.md$/, '$2')
    const canonical = `${SITE_ORIGIN}/${path}`.replace(/\/$/, '/')
    const title = pageData.frontmatter.title ?? pageData.title ?? 'ADAMANT IPFS Node'
    const description = pageData.frontmatter.description ?? pageData.description ?? ''

    pageData.frontmatter.head ??= []
    pageData.frontmatter.head.push(
      ['link', { rel: 'canonical', href: canonical }],
      ['meta', { property: 'og:type', content: 'website' }],
      ['meta', { property: 'og:url', content: canonical }],
      ['meta', { property: 'og:title', content: title }],
      ['meta', { property: 'og:description', content: description }]
    )
  },

  themeConfig: {
    logo: { src: '/logo.svg', alt: 'ADAMANT IPFS Node logo' },
    siteTitle: 'ADAMANT IPFS Node',

    nav: [
      { text: 'Guide', link: '/guide/what-is-it' },
      { text: 'Reference', link: '/reference/api' },
      { text: 'Operations', link: '/operations/monitoring' },
      {
        text: 'Project',
        items: [
          { text: 'Source', link: 'https://github.com/Adamant-im/ipfs-node' },
          { text: 'Releases', link: 'https://github.com/Adamant-im/ipfs-node/releases' },
          {
            text: 'Container package',
            link: 'https://github.com/Adamant-im/ipfs-node/pkgs/container/ipfs-node'
          },
          { text: 'Issues', link: 'https://github.com/Adamant-im/ipfs-node/issues' }
        ]
      }
    ],

    sidebar: [
      {
        text: 'Introduction',
        items: [
          { text: 'What it is', link: '/guide/what-is-it' },
          { text: 'Use cases', link: '/guide/use-cases' },
          { text: 'Comparison', link: '/guide/comparison' },
          { text: 'Architecture', link: '/guide/architecture' }
        ]
      },
      {
        text: 'Get started',
        items: [
          { text: 'Quick start', link: '/guide/quick-start' },
          { text: 'Docker', link: '/guide/docker' },
          { text: 'Installation', link: '/guide/installation' },
          { text: 'Configuration', link: '/guide/configuration' },
          { text: 'Security and privacy', link: '/guide/security' }
        ]
      },
      {
        text: 'Reference',
        items: [
          { text: 'API overview', link: '/reference/api' },
          { text: 'Endpoint reference', link: '/reference/endpoints' },
          { text: 'Storage lifecycle', link: '/storage-lifecycle' }
        ]
      },
      {
        text: 'Operations',
        items: [
          { text: 'Monitoring and health', link: '/operations/monitoring' },
          { text: 'Persistent state and backups', link: '/operations/persistence' },
          { text: 'Upgrades and rollback', link: '/operations/upgrades' },
          { text: 'Troubleshooting', link: '/operations/troubleshooting' }
        ]
      },
      {
        text: 'Project',
        items: [
          { text: 'ADAMANT Messenger', link: '/guide/adamant-messenger' },
          { text: 'Contributing', link: '/guide/contributing' }
        ]
      }
    ],

    outline: { level: [2, 3], label: 'On this page' },

    socialLinks: [{ icon: 'github', link: 'https://github.com/Adamant-im/ipfs-node' }],

    editLink: {
      pattern: `https://github.com/Adamant-im/ipfs-node/edit/${REPOSITORY_BRANCH}/docs/:path`,
      text: 'Edit this page on GitHub'
    },

    search: {
      provider: 'local'
    },

    footer: {
      message: 'Released under the GPL-3.0 License.',
      copyright: 'Copyright (c) ADAMANT Foundation and contributors'
    }
  }
})
