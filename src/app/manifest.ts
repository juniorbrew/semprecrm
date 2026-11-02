import type { MetadataRoute } from 'next';

// Makes SempreCRM installable on the phone (ícone na tela, tela cheia).
// Next links it from <head> automatically. Global brand: accounts with
// white-label still install as "SempreCRM".
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/dashboard',
    name: 'SempreCRM',
    short_name: 'SempreCRM',
    description: 'CRM com WhatsApp para pequenos negócios.',
    lang: 'pt-BR',
    start_url: '/dashboard',
    scope: '/',
    display: 'standalone',
    background_color: '#020617',
    theme_color: '#020617',
    icons: [
      { src: '/icons/192', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/512', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
