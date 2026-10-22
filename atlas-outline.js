// Estructura del libro de InDesign (INDB) según el panel y el índice definitivos
// compartidos por el autor. Es un mapa de navegación; no modifica los originales.
window.PROJECT_ATLAS_OUTLINE = [
  {
    id: 'preliminares', label: 'Preliminares', number: '0', marker: 'DOCUMENTOS INICIALES', glyph: '00',
    description: 'Documentos iniciales del libro de InDesign, en el orden del archivo INDB.',
    // Estos documentos son entradas del libro, no apartados que contengan entradas.
    // Se conservan aparte para reconocer asignaciones previas y mostrarlos directamente.
    nodes: [],
    entryNodes: [
      { id: 'pre-01', number: '0.1', label: 'Carátulas URL' },
      { id: 'pre-02', number: '0.2', label: 'Carta del asesor' },
      { id: 'pre-03', number: '0.3', label: 'Orden de impresión' },
      { id: 'pre-04', number: '0.4', label: 'Agradecimientos' },
      { id: 'pre-05', number: '0.5', label: 'Dedicatoria' },
      { id: 'indice', number: '0.6', label: 'Índice de contenidos' },
      { id: 'resumen', number: '0.7', label: 'Resumen' },
      { id: 'introduccion', number: '0.8', label: 'Introducción' },
      { id: 'portada', number: '0.9', label: 'Carátula PG' }
    ]
  },
  {
    id: 'investigacion', label: 'Gestión de la investigación', number: '1', marker: 'CAPÍTULO 1', glyph: '01',
    description: 'Investigación, marco de referencia, marco de diseño y grupo objetivo.',
    nodes: [
      { id: 'pgdg-2', number: '1.1', label: 'Planteamiento y objetivos de investigación', children: [
        { id: 'pgdg-1', number: '1.1.1', label: 'Planteamiento del problema' },
        { id: 'research-questions', number: '1.1.2', label: 'Preguntas de investigación' },
        { id: 'research-objectives', number: '1.1.3', label: 'Objetivos de investigación' }
      ] },
      { id: 'pgdg-3', number: '1.2', label: 'Metodología de investigación', children: [
        { id: 'pgdg-3-1', number: '1.2.1', label: 'Sujetos de estudio' },
        { id: 'pgdg-3-2', number: '1.2.2', label: 'Objetos de estudio' },
        { id: 'research-techniques', number: '1.2.3', label: 'Técnicas de investigación', children: [
          { id: 'research-focus-group', number: '1.2.3.1', label: 'Focus group' },
          { id: 'research-interview', number: '1.2.3.2', label: 'Entrevista en profundidad' }
        ] },
        { id: 'pgdg-3-3', number: '1.2.4', label: 'Instrumentos' }
      ] },
      { id: 'pgdg-4', number: '1.3', label: 'Marco de referencia', children: [
        { id: 'reference-clutter', number: '1.3.1', label: 'Clutter (desorden por acumulación)' },
        { id: 'reference-disorganization', number: '1.3.2', label: 'Desorganización crónica y su impacto en la vida cotidiana' },
        { id: 'reference-wellbeing', number: '1.3.3', label: 'Autonomía y bienestar psicológico frente al clutter' },
        { id: 'reference-minimalism', number: '1.3.4', label: 'Minimalismo como alfabetización emocional' },
        { id: 'pgdg-4-local', number: '1.3.5', label: 'Antecedentes locales de comunicación' },
        { id: 'reference-subject', number: '1.3.6', label: 'Sujeto de estudio – Marco de referencia' }
      ] },
      { id: 'pgdg-5', number: '1.4', label: 'Marco de diseño', children: [
        { id: 'design-campaigns', number: '1.4.1', label: 'Campañas y sus elementos' },
        { id: 'design-websites', number: '1.4.2', label: 'Sitios web y su diseño' },
        { id: 'design-audiovisual', number: '1.4.3', label: 'Audiovisuales para informar' },
        { id: 'design-editorial', number: '1.4.4', label: 'Diseño de publicaciones editoriales' },
        { id: 'design-illustration', number: '1.4.5', label: 'Ilustración y comunicación' },
        { id: 'pgdg-5-foreign', number: '1.4.6', label: 'Casos análogos de éxito', children: [
          { id: 'case-kondo', number: '1.4.6.1', label: 'Marie Kondo · Método KonMari' },
          { id: 'case-becker', number: '1.4.6.2', label: 'Joshua Becker · Becoming Minimalist' },
          { id: 'case-sasaki', number: '1.4.6.3', label: 'Fumio Sasaki · Minimalismo existencial' }
        ] },
        { id: 'design-subject', number: '1.4.7', label: 'Sujeto de estudio – Marco de diseño' }
      ] },
      { id: 'pgdg-6', number: '1.5', label: 'Grupo objetivo', children: [
        { id: 'audience-methodology', number: '1.5.1', label: 'Metodología', children: [
          { id: 'audience-focus-group', number: '1.5.1.1', label: 'Focus group' },
          { id: 'audience-interview', number: '1.5.1.2', label: 'Entrevista en profundidad' },
          { id: 'audience-observation', number: '1.5.1.3', label: 'Observación participativa' }
        ] },
        { id: 'audience-profiles', number: '1.5.2', label: 'Perfiles', children: [
          { id: 'audience-demographic', number: '1.5.2.1', label: 'Perfil demográfico' },
          { id: 'audience-geographic', number: '1.5.2.2', label: 'Perfil geográfico' },
          { id: 'audience-psychographic', number: '1.5.2.3', label: 'Perfil psicográfico' },
          { id: 'audience-psychopedagogic', number: '1.5.2.4', label: 'Perfil psicopedagógico' }
        ] },
        { id: 'audience-tools', number: '1.5.3', label: 'Herramientas de análisis del usuario', children: [
          { id: 'audience-empathy', number: '1.5.3.1', label: 'Mapa de empatía' },
          { id: 'audience-persona', number: '1.5.3.2', label: 'Buyer persona' },
          { id: 'audience-journey', number: '1.5.3.3', label: 'Customer journey map' }
        ] },
        { id: 'audience-infographic', number: '1.5.4', label: 'Infografía del grupo objetivo' },
        { id: 'pgdg-6-results', number: '1.5.5', label: 'Resultados de encuesta del grupo objetivo' }
      ] },
      { id: 'pgdg-8', number: '1.6', label: 'Conclusiones y recomendaciones de investigación', children: [
        { id: 'research-conclusions', number: '1.6.1', label: 'Conclusiones de investigación' },
        { id: 'research-recommendations', number: '1.6.2', label: 'Recomendaciones de investigación' }
      ] }
    ]
  },
  {
    id: 'creacion', label: 'Gestión de la creación', number: '2', marker: 'CAPÍTULO 2', glyph: '02',
    description: 'Definición de la necesidad, planeación, conceptualización, propuesta y validación.',
    nodes: [
      { id: 'pgdg-9', number: '2.1', label: 'Comprensión de la necesidad' },
      { id: 'pgdg-10', number: '2.2', label: 'Objetivos de diseño' },
      { id: 'pgdg-11', number: '2.3', label: 'Planeación estratégica', children: [
        { id: 'pgdg-11-1', number: '2.3.1', label: 'Estrategia de comunicación' },
        { id: 'pgdg-11-2', number: '2.3.2', label: 'Selección de piezas' },
        { id: 'creation-communication-diagram', number: '2.3.3', label: 'Diagrama de comunicación' }
      ] },
      { id: 'pgdg-7', number: '2.4', label: 'Aliado estratégico', children: [
        { id: 'strategic-partners-proposal', number: '2.4.1', label: 'Propuesta de aliados estratégicos' }
      ] },
      { id: 'pgdg-12', number: '2.5', label: 'Conceptualización', children: [
        { id: 'pgdg-12-1', number: '2.5.1', label: 'Búsqueda del concepto' },
        { id: 'pgdg-12-2', number: '2.5.2', label: 'Fundamentación del concepto' }
      ] },
      { id: 'pgdg-13', number: '2.6', label: 'Codificación del mensaje' },
      { id: 'pgdg-14', number: '2.7', label: 'Bocetaje' },
      { id: 'pgdg-14-1', number: '2.8', label: 'Propuesta preliminar' },
      { id: 'pgdg-15', number: '2.9', label: 'Validación', children: [
        { id: 'pgdg-15-methodology', number: '2.9.1', label: 'Metodología' },
        { id: 'pgdg-15-1', number: '2.9.2', label: 'Análisis de resultados' },
        { id: 'pgdg-15-2', number: '2.9.3', label: 'Cambios de validación' }
      ] }
    ]
  },
  {
    id: 'implementacion', label: 'Gestión de la implementación', number: '3', marker: 'CAPÍTULO 3', glyph: '03',
    description: 'Propuesta final, producción, reproducción y cierre de diseño.',
    nodes: [
      { id: 'pgdg-16', number: '3.1', label: 'Propuesta final y fundamentación' },
      { id: 'pgdg-17', number: '3.2', label: 'Producción y reproducción', children: [
        { id: 'pgdg-17-1', number: '3.2.1', label: 'Especificaciones técnicas' },
        { id: 'pgdg-17-2', number: '3.2.2', label: 'Informe técnico' },
        { id: 'implementation-social', number: '3.2.3', label: 'Planificación de redes' },
        { id: 'implementation-style-guide', number: '3.2.4', label: 'Guía de estilos' },
        { id: 'pgdg-17-3', number: '3.2.5', label: 'Presupuesto de reproducción y diseño' }
      ] },
      { id: 'pgdg-18', number: '3.3', label: 'Conclusiones y recomendaciones de diseño', children: [
        { id: 'design-conclusions', number: '3.3.1', label: 'Conclusiones de diseño' },
        { id: 'design-recommendations', number: '3.3.2', label: 'Recomendaciones de diseño' }
      ] }
    ]
  },
  {
    id: 'cierre-documental', label: 'Referencias y créditos', number: '4', marker: 'CAPÍTULO 4', glyph: '04',
    description: 'Fuentes citadas y créditos de las figuras del libro.',
    nodes: [
      { id: 'pgdg-19', number: '4.1', label: 'Referencias' },
      { id: 'pgdg-20', number: '4.2', label: 'Créditos de figuras' }
    ]
  },
  {
    id: 'anexos', label: 'Anexos', number: '5', marker: 'CAPÍTULO 5', glyph: '05',
    description: 'Documentos de apoyo organizados por instrumentos, análisis y entregables.',
    nodes: [
      { id: 'pgdg-21', number: '5.1', label: 'Instrumentos de investigación', children: [
        { id: 'annex-01', number: '5.1.1', label: 'Anexo 01 · Cuestionario · Sujeto de estudio (Marco de referencia) · Licda. Alejandra Flores' },
        { id: 'annex-02', number: '5.1.2', label: 'Anexo 02 · Resultados del cuestionario · Sujeto de estudio (Marco de referencia) · Licda. Alejandra Flores' },
        { id: 'annex-03', number: '5.1.3', label: 'Anexo 03 · Cuestionario · Sujeto de estudio (Marco de referencia) · Coronel (R) Marco Tulio Díaz Santos' },
        { id: 'annex-04', number: '5.1.4', label: 'Anexo 04 · Resultados del cuestionario · Sujeto de estudio (Marco de referencia) · Coronel (R) Marco Tulio Díaz Santos' },
        { id: 'annex-05', number: '5.1.5', label: 'Anexo 05 · Entrevista en profundidad · Sujeto de estudio (Marco de diseño) · Diseñador Johnatan Aceituno' },
        { id: 'annex-06', number: '5.1.6', label: 'Anexo 06 · Resultados de la entrevista · Sujeto de estudio (Marco de diseño) · Diseñador Johnatan Aceituno' }
      ] },
      { id: 'annex-cases', number: '5.2', label: 'Observación y análisis de casos', children: [
        { id: 'annex-07', number: '5.2.1', label: 'Anexo 07 · Guía de observación · Objeto de estudio (local e internacional)' },
        { id: 'annex-08', number: '5.2.2', label: 'Anexo 08 · Resultados de observación · Caso local: Campaña #DIME' },
        { id: 'annex-09', number: '5.2.3', label: 'Anexo 09 · Resultados de observación · Caso local: Campaña «En mi mente»' },
        { id: 'annex-10', number: '5.2.4', label: 'Anexo 10 · Resultados de observación · Caso local: Campaña #QueNoTePase' },
        { id: 'annex-11', number: '5.2.5', label: 'Anexo 11 · Resultados de observación · Caso internacional' },
        { id: 'annex-12', number: '5.2.6', label: 'Anexo 12 · Resultados de observación' },
        { id: 'annex-13', number: '5.2.7', label: 'Anexo 13 · Resultados de observación' }
      ] },
      { id: 'annex-audience', number: '5.3', label: 'Investigación del grupo objetivo', children: [
        { id: 'annex-14', number: '5.3.1', label: 'Anexo 14 · Guía de encuesta · Grupo objetivo' },
        { id: 'annex-15', number: '5.3.2', label: 'Anexo 15 · Resultados de encuesta · Grupo objetivo' },
        { id: 'annex-16', number: '5.3.3', label: 'Anexo 16 · Guía de observación netnográfica' },
        { id: 'annex-17', number: '5.3.4', label: 'Anexo 17 · Resultados de observación netnográfica' }
      ] },
      { id: 'annex-user-tools', number: '5.4', label: 'Herramientas de análisis del usuario', children: [
        { id: 'annex-18', number: '5.4.1', label: 'Anexo 18 · Mapa de empatía' },
        { id: 'annex-19', number: '5.4.2', label: 'Anexo 19 · Buyer persona' },
        { id: 'annex-20', number: '5.4.3', label: 'Anexo 20 · Customer journey map' }
      ] },
      { id: 'annex-validation', number: '5.5', label: 'Validación de la propuesta', children: [
        { id: 'annex-21', number: '5.5.1', label: 'Anexo 21 · Instrumento de validación · Grupo objetivo' },
        { id: 'annex-22', number: '5.5.2', label: 'Anexo 22 · Instrumento de validación · Diseñadores' },
        { id: 'annex-23', number: '5.5.3', label: 'Anexo 23 · Instrumento de validación · Expertos en el tema' },
        { id: 'annex-24', number: '5.5.4', label: 'Anexo 24 · Resultados de validación · Grupo objetivo' },
        { id: 'annex-25', number: '5.5.5', label: 'Anexo 25 · Resultados de validación · Diseñadores' },
        { id: 'annex-26', number: '5.5.6', label: 'Anexo 26 · Resultados de validación · Expertos en el tema' }
      ] },
      { id: 'annex-development', number: '5.6', label: 'Desarrollo de la propuesta', children: [
        { id: 'annex-27', number: '5.6.1', label: 'Anexo 27 · Bocetaje y cambios derivados de la validación' }
      ] },
      { id: 'annex-technical', number: '5.7', label: 'Documentación técnica y presupuestaria', children: [
        { id: 'annex-28', number: '5.7.1', label: 'Anexo 28 · Cotización de pautas en redes' },
        { id: 'annex-29', number: '5.7.2', label: 'Anexo 29 · Cotización de impresiones' },
        { id: 'annex-30', number: '5.7.3', label: 'Anexo 30 · Cotización de diseño' }
      ] },
      { id: 'sample-styles', number: '', label: 'SAMPLE STYLES' }
    ]
  },
  {
    id: 'sin-clasificar', label: 'Por ubicar', marker: 'REVISIÓN DE UBICACIÓN', glyph: '…',
    description: 'Entradas cuya ubicación dentro del índice definitivo todavía necesita confirmación.', nodes: []
  }
];
