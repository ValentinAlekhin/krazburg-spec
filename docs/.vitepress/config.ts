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
      { text: '1. О проекте', link: '/project/overview' },
      { text: '2. Конструктор', link: '/spec/constructor' },
      { text: '7. Архитектура', link: '/spec/architecture' },
      { text: '6. CMS', link: '/spec/admin' },
      { text: '9. Для переноса', link: '/project/questions' },
    ],
    sidebar: [
      { text: 'Начало', items: [
        { text: 'Новый сайт KRAZBURG', link: '/' },
        { text: '1. Задача и границы проекта', link: '/project/overview' },
      ] },
      { text: 'Техническое задание', items: [
        { text: '2. Конструктор', link: '/spec/constructor' },
        { text: '3. Расчёт материалов', link: '/spec/calculation' },
        { text: '4. Каталог и параметры конструктора', link: '/spec/catalog' },
        { text: '5. Расчёты, заказы и оплата', link: '/spec/leads' },
        { text: '6. CMS и управление сайтом', link: '/spec/admin' },
        { text: '7. Архитектура и эксплуатация', link: '/spec/architecture' },
        { text: '8. Приёмка', link: '/spec/acceptance' },
        { text: '9. Материалы и решения для переноса', link: '/project/questions' },
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
