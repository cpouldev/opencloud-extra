# OpenCloud Extra

OpenCloud Extra is an independent downstream distribution of OpenCloud with
additional thumbnails for videos (including HEVC), Photoshop, PDF-compatible
Illustrator files, fonts, modern images, RAW photos, Office documents, creative
archives, audio, books, and source files.

- **Container:** `docker.io/cpoul/opencloud-extra:stable` (Linux amd64 and arm64).
- **Stable branch:** `extra/stable`, based on upstream release tags.
- **Maintenance:** daily upstream release checks, tested merges, and automatic
  container publication. Custom work and automation stay in this fork.
- **Setup, formats, limits, and releases:** [OpenCloud Extra guide](docs/opencloud-extra.md).

This project is not an official OpenCloud release. Report downstream problems and
propose changes in [cpouldev/opencloud-extra](https://github.com/cpouldev/opencloud-extra).
Never send this fork's customizations or automated pull requests upstream.

![OpenCloud logo](https://raw.githubusercontent.com/opencloud-eu/opencloud/refs/heads/main/opencloud_logo.png)

[![status-badge](https://ci.opencloud.rocks/api/badges/3/status.svg)](https://ci.opencloud.rocks/repos/3)
 [![Matrix](https://img.shields.io/matrix/opencloud%3Amatrix.org?logo=matrix)](https://app.element.io/#/room/#opencloud:matrix.org)
 [![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

# Server Backend


> [!TIP]
> For general information about OpenCloud and how to install please visit [OpenCloud on Github](https://github.com/opencloud-eu/) and [OpenCloud GmbH](https://opencloud.eu).

This fork contains the Go codebase for the OpenCloud backend services, together
with the OpenCloud Extra thumbnail providers and release automation.

## Getting Involved

The OpenCloud server is released under [Apache 2.0](https://github.com/opencloud-eu/opencloud/blob/main/LICENSE).
For OpenCloud Extra, use this fork's [issues](https://github.com/cpouldev/opencloud-extra/issues)
and [pull requests](https://github.com/cpouldev/opencloud-extra/pulls).
Read [AGENTS.md](AGENTS.md) before working on automation: upstream access is read-only.

## Build OpenCloud

To build the backend, follow these instructions:

Generate the assets needed by e.g., the web UI and the builtin IDP

``` console
make generate
```

Then compile the `opencloud` binary

``` console
make -C opencloud build
```
That will produce the binary `opencloud/bin/opencloud`. It can be started as a local test instance right away with a two step command:

```bash
opencloud/bin/opencloud init && opencloud/bin/opencloud server
```
This creates a server configuration (by default in `$HOME/.opencloud`) and starts the server.

For more setup- and installation options consult the [Development Documentation](https://docs.opencloud.eu/).

## Technology

Important information for contributors about the technology in use.

### Authentication

The OpenCloud backend authenticates users via [OpenID Connect](https://openid.net/connect/) using either an external IdP like [Keycloak](https://www.keycloak.org/) or the embedded [LibreGraph Connect](https://github.com/libregraph/lico) identity provider.

### Database

The OpenCloud backend does not use a database. It stores all data in the filesystem. By default, the root directory of the backend is `$HOME/.opencloud/`.

## Security

If you find a security-related issue, please contact [security@opencloud.eu](mailto:security@opencloud.eu) immediately.
