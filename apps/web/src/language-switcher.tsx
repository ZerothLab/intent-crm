import { getLocale, setLocale, t, useLocale } from './i18n';
export function LanguageSwitcher(){
  useLocale();
  return <label className="language-switcher"><span className="sr-only">{t('Language')}</span><select aria-label={t('Language')} value={getLocale()} onChange={e=>setLocale(e.target.value==='zh-CN'?'zh-CN':'en')}><option value="en">English</option><option value="zh-CN">中文</option></select></label>;
}
