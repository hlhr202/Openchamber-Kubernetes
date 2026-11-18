# OpenChamber Kubernetes Explorer

[English](../README.md) | [简体中文](README.zh-CN.md) | [العربية](README.ar.md) | [Deutsch](README.de.md) | Español | [Français](README.fr.md) | [עברית](README.he.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Nederlands](README.nl.md) | [Polski](README.pl.md) | [Português (Brasil)](README.pt-BR.md) | [Türkçe](README.tr.md) | [Українська](README.uk.md) | [繁體中文](README.zh-TW.md)

Una extensión de Kubernetes para OpenChamber. Explora tus clústeres, diagnostica problemas en las cargas de trabajo y realiza operaciones habituales de Kubernetes sin salir del espacio de trabajo de tu proyecto.

## Instalación

Una vez publicados los archivos precompilados de la extensión en la rama predeterminada del repositorio:

1. En OpenChamber, abre **Configuración → Extensiones**.
2. Pega la URL del repositorio en **Carpeta, ZIP o URL** y pulsa **Añadir**:

   ```text
   https://github.com/hlhr202/Openchamber-Kubernetes
   ```

3. Revisa y permite el acceso al servicio local solicitado. A continuación, abre **Kubernetes** desde la barra de extensiones.

No necesitas compilar localmente ni instalar dependencias de JavaScript. Mientras el repositorio sea privado, OpenChamber Server debe contar con credenciales de Git que permitan leerlo por HTTPS. Iniciar sesión en GitHub desde el navegador no proporciona esas credenciales al servidor.

La [versión candidata verificada en Docker](status.md) también ofrece un ZIP precompilado para la instalación manual. La instalación mediante URL de Git aún no se ha verificado.

## Requisitos previos

- **OpenChamber 2.5.1**, la versión para la que se ha diseñado la extensión.
- Un **kubeconfig** válido y accesible para el usuario del sistema operativo que ejecuta OpenChamber Server, con acceso de red a la API de Kubernetes y permisos para las operaciones que quieras realizar.
- **`kubectl`** debe estar disponible en el servidor. Las operaciones que invocan la CLI de Helm necesitan **Helm**. Si tu kubeconfig usa un proveedor externo de credenciales, ese programa también debe estar disponible en el servidor. La extensión no instala estas herramientas.

## Funciones

- Cambia de contexto y espacio de nombres de Kubernetes y explora cargas de trabajo, servicios y recursos personalizados en un árbol de recursos.
- Inspecciona manifiestos, lee registros de Pods y consulta eventos del espacio de nombres.
- Revisa los cambios en los manifiestos y aplícalos de forma explícita al destino seleccionado.
- Abre una terminal en el contenedor seleccionado o configura el reenvío de puertos.
- Explora repositorios, charts, releases e historiales de revisiones de Helm.

## Qué ha probado el autor

El autor solo ha probado personalmente cuatro flujos: desplegar listas en el árbol de recursos, consultar los detalles de los recursos, usar la terminal de un contenedor y reenviar puertos. Si tienes dudas o encuentras problemas en otros flujos, puedes [abrir una incidencia en GitHub](https://github.com/hlhr202/Openchamber-Kubernetes/issues).

## Privacidad

- La extensión no envía datos de telemetría ni de análisis a sus desarrolladores. Usa el kubeconfig del servidor para conectarse a la API de Kubernetes configurada con tus permisos actuales.
- Los datos de recursos obtenidos, los registros, la salida de la terminal y los borradores sin guardar se mantienen en memoria, no en disco. La extensión conserva preferencias no sensibles, como las fuentes de kubeconfig seleccionadas, pero no su contenido. Guardar o exportar de forma explícita son acciones independientes.
- Los valores de los Secrets solo se muestran cuando los solicitas y tus permisos de Kubernetes lo permiten. Los datos del clúster no se envían automáticamente al chat ni a un proveedor de modelos.

Esta declaración se aplica a la extensión, no a OpenChamber, Kubernetes ni a las herramientas y los servicios externos que utilices.

## Licencia

[MIT](../LICENSE). Las dependencias incluidas conservan sus respectivas licencias; consulta `THIRD_PARTY_NOTICES.txt` en el paquete precompilado.

[Documentación del proyecto](README.md) · [Alcance del producto](product.md) · [Desarrollo](development.md)
