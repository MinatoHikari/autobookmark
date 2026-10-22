import { createApp } from 'vue';
import App from './App.vue';
import { initI18n } from '../../shared/i18n';
import '../../assets/styles.css';

// 先读界面语言再挂载，避免首帧闪现默认语言
initI18n().finally(() => createApp(App).mount('#app'));
