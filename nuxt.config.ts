export default defineNuxtConfig({
  srcDir: "app/",
  devtools: { enabled: false },
  css: ["~/assets/styles.css"],
  runtimeConfig: {
    public: {
      dashboardPort: 38127,
      routerPort: 38128,
    },
  },
  nitro: {
    preset: "node-server",
    externals: {
      inline: ["bun:sqlite", "vue", "vue/server-renderer", "vue-bundle-renderer", "lucide-vue-next"],
    },
    routeRules: {
      "/api/**": { cors: false },
    },
  },
  typescript: {
    strict: true,
    typeCheck: false,
  },
})
