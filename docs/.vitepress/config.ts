import { defineConfig } from 'vitepress';

const suppliedBase = process.env.VITEPRESS_BASE?.trim() || '/';
if (!suppliedBase.startsWith('/') || suppliedBase.includes('..') || /[?#\\]/.test(suppliedBase)) {
  throw new Error('VITEPRESS_BASE должен быть путём вида / или /repository/.');
}
const base = suppliedBase === '/' ? '/' : `${suppliedBase.replace(/\/+$/, '')}/`;

export default defineConfig({
  lang: 'ru-RU',
  title: 'KRAZBURG · Техническое задание',
  description: 'Требования к новому сайту KRAZBURG и конструктору комплектов натяжных потолков.',
  base,
  lastUpdated: true,
  appearance: true,
  // GitHub Pages serves generated .html files directly.
  cleanUrls: false,
  themeConfig: {
    siteTitle: 'KRAZBURG / ТЗ',
    nav: [
      { text: 'ТЗ', link: '/' },
      { text: '2. Админка', link: '/spec/admin' },
      { text: '5. Оплата и сроки', link: '/project/payment-and-timeline' },
    ],
    sidebar: [
      { text: 'Техническое задание', items: [
        { text: '1. Объём работ', link: '/project/overview' },
        { text: '2. Админка Strapi', link: '/spec/admin' },
        { text: '3. Сайт и окружение', link: '/spec/architecture' },
        { text: '4. Приёмка', link: '/spec/acceptance' },
        { text: '5. Оплата и сроки', link: '/project/payment-and-timeline' },
      ] },
    ],
    outline: { level: [2, 3], label: 'На этой странице' },
    docFooter: { prev: 'Предыдущая страница', next: 'Следующая страница' },
    lastUpdated: { text: 'Обновлено', formatOptions: { dateStyle: 'long', timeStyle: 'short' } },
    sidebarMenuLabel: 'Разделы',
    returnToTopLabel: 'Наверх',
    darkModeSwitchLabel: 'Оформление',
    lightModeSwitchTitle: 'Светлая тема',
    darkModeSwitchTitle: 'Тёмная тема',
    skipToContentLabel: 'Перейти к содержанию',
    notFound: { title: 'Страница не найдена', quote: 'Проверьте адрес или выберите раздел в меню.', linkLabel: 'На главную', linkText: 'Вернуться к проекту' },
    search: { provider: 'local', options: { locales: { root: { translations: {
      button: { buttonText: 'Поиск', buttonAriaLabel: 'Поиск по ТЗ' },
      modal: {
        displayDetails: 'Подробные результаты', resetButtonTitle: 'Очистить поиск', backButtonTitle: 'Закрыть поиск', noResultsText: 'Ничего не найдено',
        footer: { selectText: 'выбрать', selectKeyAriaLabel: 'Enter', navigateText: 'перейти', navigateUpKeyAriaLabel: 'стрелка вверх', navigateDownKeyAriaLabel: 'стрелка вниз', closeText: 'закрыть', closeKeyAriaLabel: 'Escape' },
      },
    } } } } },
    footer: { message: 'KRAZBURG · Новый сайт и конструктор потолков' },
  },
});
