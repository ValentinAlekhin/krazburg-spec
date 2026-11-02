import { defineComponent, h, onMounted, watch } from 'vue';
import { useData, type Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import { createMermaidRenderer } from 'vitepress-mermaid-renderer';
import 'vitepress-mermaid-renderer/css';
import './style.css';

const Layout = defineComponent({
  setup() {
    const { isDark } = useData();
    const renderDiagrams = () => {
      const renderer = createMermaidRenderer({
        theme: isDark.value ? 'dark' : 'neutral',
        securityLevel: 'strict',
        startOnLoad: false,
      });
      renderer.setToolbar({
        showLanguageLabel: false,
        fullscreenMode: 'dialog',
        downloadFormat: 'svg',
        i18n: { localeIndex: 'root', locales: { root: { tooltips: {
          zoomIn: 'Увеличить', zoomOut: 'Уменьшить', resetView: 'Сбросить вид',
          copyCode: 'Скопировать схему', copyCodeCopied: 'Скопировано',
          download: 'Скачать диаграмму', toggleFullscreen: 'На весь экран',
          renderErrorText: 'Не удалось отобразить диаграмму', toggleErrorDetailsText: 'Показать причину', toggleErrorDetailsHideText: 'Скрыть причину',
        } } } },
      });
    };
    onMounted(renderDiagrams);
    watch(isDark, renderDiagrams);
    return () => h(DefaultTheme.Layout);
  },
});

export default { extends: DefaultTheme, Layout } satisfies Theme;
