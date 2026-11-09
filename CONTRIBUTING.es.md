# Contribuir a Atum

Atum incluye un cliente de escritorio y un entorno de agente derivado de Hermes. Para errores, propuestas y documentación de Atum, usa los [issues](../../issues) y las [pull requests](../../pulls) de este repositorio. Busca primero en el código y en las conversaciones existentes. Explica cómo reproducir el problema y qué comportamiento esperas.

## Alcance y licencias

Lee [LICENSE](LICENSE), [NOTICE](NOTICE) y [THIRD-PARTY.json](THIRD-PARTY.json). El código propio de Atum tiene todos los derechos reservados, salvo los derechos de visualización y bifurcación descritos allí. Las licencias y los créditos de Hermes y de otros terceros siguen vigentes. Una contribución no modifica esas condiciones.

Limita el cambio al problema concreto. Conserva la caché de conversaciones, el aislamiento del entorno y los contratos entre cliente y servidor. Amplía los módulos o las interfaces existentes antes de crear mecanismos paralelos. Mantén los créditos originales y evita cambios de formato ajenos al trabajo.

## Comprobaciones locales

Usa una versión de Node compatible con `package.json` y las versiones fijadas de Python y uv. Ejecuta `npm ci --ignore-scripts` y `npm run typecheck --workspace apps/desktop`. Desde `apps/desktop`, ejecuta los tests afectados con `../../node_modules/.bin/vitest run <archivos-de-test>`. Para Python, usa `bash scripts/run_tests.sh <rutas-de-test> -j 3`. Revisa los requisitos de plataforma y servicios antes de activar tests de integración. No uses cuentas, credenciales ni datos de producción como fixtures.

En la pull request, describe los cambios y las comprobaciones realizadas. Distingue los tests omitidos de los que pasan. La firma de versiones, la infraestructura, los secretos y la publicación no forman parte de las comprobaciones habituales de una contribución. El proyecto móvil requiere actualmente Xcode 27; su job de simulador queda desactivado hasta que una imagen hospedada estándar incluya esa herramienta.

## Seguridad y créditos

No publiques vulnerabilidades ni credenciales en un issue. Usa los [informes privados de este repositorio](../../security/advisories/new) o **security@atumplatform.com**; consulta [SECURITY.es.md](SECURITY.es.md).

Atum deriva de [Hermes Agent de Nous Research](https://github.com/NousResearch/hermes-agent). Conserva su aviso MIT y las demás atribuciones. Las contribuciones y consultas específicas de Atum se gestionan en este repositorio de Atum.
