# ai-agents-demo — AI agent auth/authz demo (Curity + SPIFFE/SPIRE + Istio Ambient)
#
# Single authoritative entry point for the whole environment lifecycle:
#
#   make demo        # stand up the full platform on a fresh KIND cluster
#                    # (seeds the license, demo users and every workload secret)
#   make images apply
#   make status      # health-check everything
#   make smoke       # run the auth/authz smoke tests
#   make clean       # tear it all down
#
# See README.md for setup and troubleshooting and docs/architecture.md for the
# system design. `make help` lists every target.

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

# ---- configuration ----
CLUSTER_NAME ?= ai-agents-demo
KIND_CONFIG  ?= k8s/kind/cluster.yaml

NS_CURITY  ?= curity
NS_AGENTS  ?= agents
NS_MCP     ?= mcp
NS_APIS    ?= apis
NS_WEB     ?= web
NS_INGRESS ?= istio-ingress

HOST_APP          ?= app.localtest.me
HOST_CURITY       ?= curity.localtest.me
HOST_CURITY_ADMIN ?= curity-admin.localtest.me
HOST_GRAFANA      ?= grafana.localtest.me
HOST_COPILOT      ?= copilot.localtest.me
HOST_SPECIALIST   ?= specialist.localtest.me
HOST_MCP_OPS      ?= mcp-ops.localtest.me
HOST_MCP_INSPECT      ?= mcp-inspect.localtest.me
HOST_MCP_GATEWAY  ?= mcp-gateway.localtest.me

CERT_DIR ?= certs

# App images, keyed by their apps/<name>/Dockerfile. Used by `make images`
# (build + kind load) and `make clean` (removal).
IMAGE_NAMES ?= mcp-inspect mcp-ops ops-api inspect-api agent-copilot agent-specialist web exchange-shim
# The subset `make images` actually builds — defaults to everything. Override to
# rebuild one or more: `make images IMAGES="web agent-copilot"`, or `make image-web`.
IMAGES ?= $(IMAGE_NAMES)

# Where each image runs, for the post-load "now restart these" hint (a reloaded :dev
# image does NOT restart a running pod — imagePullPolicy IfNotPresent keeps the old one).
# exchange-shim is a sidecar inside the agentgateway Deployment.
image_deploy = $(if $(filter exchange-shim,$1),mcp/agentgateway,$(if $(filter agent-%,$1),agents/$1,$(if $(filter mcp-%,$1),mcp/$1,$(if $(filter %-api,$1),apis/$1,$1/$1))))

# ---- platform chart versions (PINNED — see below) ----
# Every `helm upgrade --install` passes an explicit --version. Without one Helm
# silently resolves whatever is newest in the repo at install time, so two runs of
# `make demo` weeks apart can build different clusters with no diff to blame it
# on. That matters more here than usual: the SPIRE hardened chart's namespace
# split and the shared Istio/SPIRE root CA (hard-won facts #8 and #18) are exactly
# the kind of wiring a chart bump rearranges.
#
# Values below are what the working demo cluster runs (captured 2026-08-05).
# To move up: bump one, `make platform`, and re-run `make status` + `make smoke`.
ISTIO_VERSION      ?= 1.30.3
SPIRE_VERSION      ?= 0.30.0
SPIRE_CRDS_VERSION ?= 0.6.0
TEMPO_VERSION      ?= 1.24.4
GRAFANA_VERSION    ?= 10.5.15
KIALI_VERSION      ?= 2.30.0

# ============================================================================
# Help
# ============================================================================
.PHONY: help
help: ## Show available targets
	@grep -E '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-24s\033[0m %s\n", $$1, $$2}'

# ============================================================================
# Preflight + TypeScript workspace
# ============================================================================
.PHONY: tools-check
tools-check: ## Verify required CLIs (node>=22, pnpm, docker, kind, kubectl, helm, mkcert, python3); warns if optional qrencode is missing
	@bash scripts/tools-check.sh

.PHONY: install
install: ## pnpm install all workspaces
	pnpm install

.PHONY: hooks
hooks: ## Install the repo git hooks (pre-commit guard against committing the license / API key)
	git config core.hooksPath .githooks
	@echo "==> git hooks active (.githooks). Bypass once with: git commit --no-verify"

.PHONY: build
build: ## Build all TypeScript workspaces (turbo)
	pnpm turbo run build

.PHONY: test
test: test-scripts ## Run all unit tests (vitest, via turbo) + the shell-script contract tests
	pnpm turbo run test

.PHONY: test-scripts
test-scripts: ## Run the shell-script contract tests (gateway-config render, Curity theme embed, user seeding, MCP discovery config, JWKS guard)
	bash scripts/test-render-gateway-config.sh
	bash scripts/test-embed-curity-theme.sh
	bash scripts/test-seed-curity-users.sh
	bash scripts/test-mcp-discovery-config.sh
	bash scripts/test-jwks-guard.sh

.PHONY: typecheck
typecheck: ## Type-check all workspaces
	pnpm turbo run typecheck

.PHONY: lint
lint: ## Lint all workspaces
	pnpm turbo run lint

# ============================================================================
# Cluster lifecycle
# ============================================================================
.PHONY: kind-up
kind-up: ## Create the KIND cluster (idempotent)
	kind get clusters | grep -q '^$(CLUSTER_NAME)$$' || \
		kind create cluster --name $(CLUSTER_NAME) --config $(KIND_CONFIG)
	CLUSTER_NAME=$(CLUSTER_NAME) bash scripts/node-nofile-fix.sh
	kubectl cluster-info --context kind-$(CLUSTER_NAME)

.PHONY: kind-down
kind-down: ## Delete the KIND cluster
	-kind delete cluster --name $(CLUSTER_NAME)

# ============================================================================
# TLS certificates (mkcert local CA for *.localtest.me)
# ============================================================================
.PHONY: certs
certs: ## Generate mkcert TLS certs for the *.localtest.me hostnames (does NOT touch the keychain)
	bash scripts/mkcert-bootstrap.sh

.PHONY: trust-ca
trust-ca: ## Install the mkcert root CA into the system trust store to silence browser TLS warnings
	mkcert -install
	@echo "==> mkcert root CA installed in the system trust store. Browser TLS warnings are gone."
	@echo "    Undo anytime with: mkcert -uninstall"

.PHONY: tls-secrets
tls-secrets: ## Apply mkcert certs as per-namespace TLS secrets (incl. the edge gateway)
	bash scripts/apply-tls-secrets.sh

# ============================================================================
# Shared root CA. One root signs both istiod's intermediate (Istio plug-in CA,
# `cacerts`) and SPIRE's intermediate (disk UpstreamAuthority), so Istio mTLS
# certs and SPIRE SVIDs chain to a single root. Key material is generated
# locally (certs/, gitignored) and seeded out-of-band — never committed.
# These MUST run before istiod / spire install so each boots with its CA.
# ============================================================================
.PHONY: gen-ca
gen-ca: ## Generate the shared root + Istio/SPIRE intermediates (idempotent: keeps existing)
	@test -f $(CERT_DIR)/shared-ca/root-cert.pem \
	  && echo "==> Shared CA already present at $(CERT_DIR)/shared-ca (delete to rotate)" \
	  || bash scripts/gen-shared-ca.sh

.PHONY: seed-istio-ca
seed-istio-ca: gen-ca ## Seed istiod's plug-in CA (`cacerts` in istio-system) from the shared root
	kubectl apply -f k8s/istio/namespace.yaml
	kubectl -n istio-system create secret generic cacerts \
	  --from-file=root-cert.pem=$(CERT_DIR)/shared-ca/istio/root-cert.pem \
	  --from-file=cert-chain.pem=$(CERT_DIR)/shared-ca/istio/cert-chain.pem \
	  --from-file=ca-cert.pem=$(CERT_DIR)/shared-ca/istio/ca-cert.pem \
	  --from-file=ca-key.pem=$(CERT_DIR)/shared-ca/istio/ca-key.pem \
	  --dry-run=client -o yaml | kubectl apply -f -

.PHONY: seed-spire-ca
seed-spire-ca: gen-ca ## Seed SPIRE's disk UpstreamAuthority secret (spiffe-upstream-ca in spire-server)
	kubectl apply -f k8s/spire/namespace.yaml
	kubectl -n spire-server create secret generic spiffe-upstream-ca \
	  --from-file=tls.crt=$(CERT_DIR)/shared-ca/spire/tls.crt \
	  --from-file=tls.key=$(CERT_DIR)/shared-ca/spire/tls.key \
	  --from-file=bundle.crt=$(CERT_DIR)/shared-ca/spire/bundle.crt \
	  --dry-run=client -o yaml | kubectl apply -f -

# ============================================================================
# Platform components (Helm installs). `make platform` installs all of them
# in dependency order; the individual targets exist for granular re-installs.
# ============================================================================
.PHONY: platform
platform: gen-ca seed-istio-ca istio-install gateway-api-crds istio-ingress-install tls-secrets seed-spire-ca spire-install telemetry-install ## Install the full in-cluster platform (mesh + ingress + SPIRE + telemetry)
	@echo "==> Platform installed. Next: seed Curity + secrets, then 'make images apply'."

.PHONY: gateway-api-crds
gateway-api-crds: ## Install the Kubernetes Gateway API CRDs (required for Istio ambient waypoints)
	kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.1/standard-install.yaml
	# istiod creates the `istio-waypoint` GatewayClass only AFTER it observes the
	# Gateway API CRDs. On a fresh install the CRDs land after istiod booted, so
	# nudge istiod to re-read them, then poll until the GatewayClass exists before
	# waiting on its condition (`kubectl wait` errors immediately on a missing
	# object rather than waiting for it to appear).
	-kubectl -n istio-system rollout restart deploy/istiod
	-kubectl -n istio-system rollout status deploy/istiod --timeout=120s
	@echo "==> Waiting for the istio-waypoint GatewayClass to be registered..."
	@for i in $$(seq 1 30); do \
	  if kubectl get gatewayclass istio-waypoint >/dev/null 2>&1; then \
	    kubectl wait --for=condition=Accepted gatewayclass/istio-waypoint --timeout=60s && exit 0; \
	  fi; \
	  echo "  ... not registered yet ($$i/30); retrying in 4s"; sleep 4; \
	done; \
	echo "ERROR: istio-waypoint GatewayClass never appeared. Check istiod:"; \
	kubectl -n istio-system get pods; \
	kubectl get gatewayclass; \
	exit 1

.PHONY: istio-install
istio-install: ## Install Istio Ambient (base + istiod + cni + ztunnel) via Helm
	helm repo add istio https://istio-release.storage.googleapis.com/charts 2>/dev/null || true
	helm repo update istio
	kubectl apply -f k8s/istio/namespace.yaml
	helm upgrade --install istio-base istio/base -n istio-system --version $(ISTIO_VERSION) --wait --timeout 3m
	helm upgrade --install istiod istio/istiod -n istio-system --version $(ISTIO_VERSION) \
	  -f k8s/istio/values-istiod.yaml --wait --timeout 5m
	helm upgrade --install istio-cni istio/cni -n istio-system --version $(ISTIO_VERSION) \
	  -f k8s/istio/values-cni.yaml --wait --timeout 3m
	helm upgrade --install ztunnel istio/ztunnel -n istio-system --version $(ISTIO_VERSION) \
	  -f k8s/istio/values-ztunnel.yaml --wait --timeout 3m

.PHONY: istio-ingress-install
istio-ingress-install: ## Install the Istio edge gateway (terminates browser TLS, hostPort 80/443)
	kubectl apply -f k8s/istio/namespace-ingress.yaml
	helm upgrade --install istio-ingress istio/gateway -n istio-ingress --version $(ISTIO_VERSION) \
	  -f k8s/istio/values-gateway.yaml --wait --timeout 3m
	# The gateway chart doesn't expose hostPort; on KIND the pod must bind 80/443
	# on the node (extraPortMappings forward to those ports).
	kubectl -n istio-ingress patch deployment istio-ingress --patch-file=k8s/istio/hostport-patch.yaml
	kubectl -n istio-ingress rollout status deploy/istio-ingress --timeout=120s

.PHONY: istio-uninstall
istio-uninstall: ## Remove all Istio Helm releases (ingress + dataplane + base)
	-helm uninstall istio-ingress -n istio-ingress
	-helm uninstall ztunnel -n istio-system
	-helm uninstall istio-cni -n istio-system
	-helm uninstall istiod -n istio-system
	-helm uninstall istio-base -n istio-system

.PHONY: spire-install
spire-install: ## Install SPIRE (CRDs + server + agent + controller-manager + CSI) via Helm
	helm repo add spiffe https://spiffe.github.io/helm-charts-hardened/ 2>/dev/null || true
	helm repo update spiffe
	kubectl apply -f k8s/spire/namespace.yaml
	# CRDs must land before the main chart — the spire chart renders ClusterSPIFFEID
	# CRs which fail without the CRD definitions present.
	helm upgrade --install spire-crds spiffe/spire-crds -n spire --version $(SPIRE_CRDS_VERSION) --wait --timeout 2m
	helm upgrade --install spire spiffe/spire -n spire --version $(SPIRE_VERSION) \
	  -f k8s/spire/values.yaml --wait --timeout 5m
	kubectl apply -f k8s/spire/identities/ 2>/dev/null || true

.PHONY: spire-uninstall
spire-uninstall: ## Remove the SPIRE Helm release (keeps the namespace + CRs)
	-helm uninstall spire -n spire

.PHONY: telemetry-install
telemetry-install: ## Install the OTel Collector + Tempo + Grafana and the trace dashboard
	helm repo add grafana https://grafana.github.io/helm-charts 2>/dev/null || true
	helm repo update grafana
	kubectl apply -f k8s/telemetry/namespace.yaml
	kubectl apply -f k8s/telemetry/collector.yaml
	kubectl apply -f k8s/telemetry/grafana-dashboards-configmap.yaml
	helm upgrade --install tempo grafana/tempo -n telemetry --version $(TEMPO_VERSION) \
	  -f k8s/telemetry/values-tempo.yaml --wait --timeout 3m
	helm upgrade --install grafana grafana/grafana -n telemetry --version $(GRAFANA_VERSION) \
	  -f k8s/telemetry/values-grafana.yaml --wait --timeout 3m
	@echo "==> Grafana: https://$(HOST_GRAFANA) (anonymous Viewer enabled)"

.PHONY: kiali-install
kiali-install: ## (Optional) Install Kiali mesh-topology UI; port-forward 20001 to view
	helm repo add kiali https://kiali.org/helm-charts 2>/dev/null || true
	helm repo update kiali
	helm upgrade --install kiali-server kiali/kiali-server -n istio-system --version $(KIALI_VERSION) \
	  --set auth.strategy=anonymous --set deployment.service_type=ClusterIP \
	  --wait --timeout 3m
	@echo "==> kubectl -n istio-system port-forward svc/kiali 20001:20001 && open http://localhost:20001"

# ============================================================================
# Curity configuration helpers
# ============================================================================
.PHONY: curity-procedures
curity-procedures: ## Embed k8s/curity/procedures/*.js as Base64 into the Curity configmap
	bash scripts/embed-curity-procedures.sh

.PHONY: curity-truststore
curity-truststore: ## Embed the local mkcert root CA into the Curity configmap's server-truststore (CIMD metadata fetch)
	bash scripts/embed-mkcert-ca.sh

.PHONY: curity-theme
curity-theme: ## Embed k8s/curity/theme/*.css as Base64 into the Curity configmap's <default-theme> (login pages match the web app)
	bash scripts/embed-curity-theme.sh

# ============================================================================
# Application images + deploy
# ============================================================================
.PHONY: images
images: ## Build app images and load them into KIND — all by default, or a subset: IMAGES="web mcp-ops" (see also image-<name>)
	@unknown="$(filter-out $(IMAGE_NAMES),$(IMAGES))"; \
	  if [ -n "$$unknown" ]; then \
	    echo "ERROR: unknown image(s): $$unknown"; \
	    echo "  valid names: $(IMAGE_NAMES)"; exit 2; fi
	@for img in $(IMAGES); do \
	  echo "==> build ai-agents-demo/$$img:dev"; \
	  docker build -t ai-agents-demo/$$img:dev -f apps/$$img/Dockerfile . || exit $$?; \
	done
	@for img in $(IMAGES); do \
	  echo "==> kind load ai-agents-demo/$$img:dev"; \
	  kind load docker-image --name $(CLUSTER_NAME) ai-agents-demo/$$img:dev || exit $$?; \
	done
	@echo ""
	@echo "==> Loaded: $(IMAGES)"
	@echo "    Running pods keep the OLD image until restarted. On a live cluster run:"
	@$(foreach img,$(IMAGES),echo "      kubectl -n $(word 1,$(subst /, ,$(call image_deploy,$(img)))) rollout restart deploy/$(word 2,$(subst /, ,$(call image_deploy,$(img))))";)
	@echo "    (a fresh 'make apply' after 'make demo' needs none of this)"

# `make image-web`, `make image-agent-copilot`, … — one image, same build + load path.
.PHONY: $(addprefix image-,$(IMAGE_NAMES))
$(addprefix image-,$(IMAGE_NAMES)): image-%: ## Build + load ONE image (image-web, image-mcp-ops, …)
	@$(MAKE) --no-print-directory images IMAGES=$*

.PHONY: apply
apply: curity-procedures curity-truststore curity-theme render-gateway-config ## Apply all manifests (assumes images built/loaded) and run routing
	kubectl apply -f k8s/namespaces.yaml
	# Curity (sole token issuer). Config BEFORE the deployment so the pod finds it
	# on first start. The `curity-license` secret is created separately by
	# `make seed-license` (run by `make demo` / `make seed-secrets`) from ./license.json.
	kubectl apply -f k8s/curity/configmap.yaml
	# The persona seeder the Curity pod's init container runs (see deployment.yaml).
	# Its inputs are the curity-demo-users Secret from `make seed-users`.
	kubectl -n $(NS_CURITY) create configmap curity-users-init-script \
	  --from-file=curity-users-init.sh=scripts/curity-users-init.sh \
	  --dry-run=client -o yaml | kubectl apply -f -
	kubectl apply -f k8s/curity/deployment.yaml
	# Target namespace + sample workloads the agents act on.
	kubectl apply -f k8s/prod/namespace.yaml
	kubectl apply -f k8s/prod/sample-deployments.yaml
	# Workload SPIFFE identities (ClusterSPIFFEID CRs) BEFORE the workloads, so the
	# controller issues each pod's SVID as it starts (tolerated if CRDs aren't up yet
	# on a fresh cluster — `make platform` already applied them at spire-install).
	kubectl apply -f k8s/spire/identities/ 2>/dev/null || true
	# Application tiers: web BFF → agents → MCP servers → backend APIs.
	kubectl apply -f k8s/workloads/web.yaml
	kubectl apply -f k8s/workloads/agent-copilot.yaml
	kubectl apply -f k8s/workloads/agent-specialist.yaml
	kubectl apply -f k8s/workloads/mcp-inspect.yaml
	kubectl apply -f k8s/workloads/mcp-ops.yaml
	# agentgateway: render its config from k8s/workloads/agentgateway-config.yaml
	# + the LLM provider fragment chosen in .demo.env (see the render-gateway-config
	# prerequisite), then create the ConfigMap from .gen/ BEFORE the Deployment.
	kubectl -n $(NS_MCP) create configmap agentgateway-config \
	  --from-file=config.yaml=.gen/agentgateway-config.yaml \
	  --dry-run=client -o yaml | kubectl apply -f -
	kubectl apply -f k8s/workloads/agentgateway.yaml
	kubectl apply -f k8s/workloads/inspect-api.yaml
	kubectl apply -f k8s/workloads/ops-api.yaml
	# Edge gateway routes (Gateway + VirtualServices + Curity DestinationRule).
	kubectl apply -f k8s/istio/gateway-edge.yaml
	# MCP L7 authz now runs at the agentgateway (k8s/workloads/agentgateway*.yaml),
	# applied above — the Istio MCP waypoint (formerly k8s/istio/mcp-l7-authz.yaml)
	# was removed in favour of it.
	# apis L7 authz: pin each backend API's caller to its fronting MCP server's
	# mTLS identity + the token's audience/scope. Its RequestAuthentication points
	# istiod at Curity's in-cluster JWKS URL, so no JWKS snapshot step is needed —
	# BUT istiod fetches that key exactly once, when it first generates the
	# waypoint's jwt_authn filter, and if Curity is still booting it inlines a
	# placeholder key and never retries (fact #38). So wait for Curity to serve
	# its JWKS through its Service BEFORE the policy exists. `make jwks-check`
	# detects the broken state, `make jwks-heal` repairs it.
	NS_CURITY=$(NS_CURITY) bash scripts/jwks-guard.sh wait
	kubectl apply -f k8s/istio/apis-l7-authz.yaml
	# Re-apply telemetry config so Collector/dashboard edits propagate without
	# a full Helm reinstall (tolerate a fresh cluster where the ns doesn't exist).
	-kubectl apply -f k8s/telemetry/namespace.yaml
	-kubectl apply -f k8s/telemetry/collector.yaml
	-kubectl apply -f k8s/telemetry/grafana-dashboards-configmap.yaml
	$(MAKE) routing

.PHONY: routing
routing: ## Patch app pods with hostAliases + mkcert CA so they can reach Curity (idempotent)
	bash scripts/cluster-routing.sh

.PHONY: routing-check
routing-check: ## Verify every app pod is wired to reach Curity (read-only; no rollout)
	bash scripts/cluster-routing.sh check

.PHONY: jwks-check
jwks-check: ## Verify the apis-waypoint validates tokens with Curity's real JWKS, not istiod's placeholder (read-only)
	NS_CURITY=$(NS_CURITY) NS_APIS=$(NS_APIS) bash scripts/jwks-guard.sh check

.PHONY: jwks-heal
jwks-heal: ## Restart the apis-waypoint so istiod re-fetches Curity's JWKS (fixes "401 Jwt verification fails" at inspect-api/ops-api)
	NS_CURITY=$(NS_CURITY) NS_APIS=$(NS_APIS) bash scripts/jwks-guard.sh heal

# ============================================================================
# Secret seeding (out-of-band — never committed). `make seed-secrets` seeds them
# all; the individual targets exist for re-seeding one. Each target is order-
# independent: it creates its namespace if missing and only restarts the workload
# if the Deployment already exists — so secrets can be seeded BEFORE `make apply`
# creates the pods (the recommended order: secrets/configmaps before pods).
# None of these prompt: the license comes from ./license.json, the LLM provider
# key from .demo.env (both gathered up front by `make demo-inputs`), and the rest
# are generated keys or the fixed demo secret "Password1". `seed-llm-secret` falls
# back to prompting if .demo.env is absent (standalone re-seed).
# ============================================================================
.PHONY: seed-secrets
seed-secrets: seed-license seed-users seed-web-secret seed-llm-secret seed-agent-key seed-specialist-key seed-mcp-ops-secret seed-mcp-inspect-secret seed-gateway-secret ## Seed the license + demo users + every workload secret + agent keys
	@echo "==> License + demo users + all workload secrets seeded."

.PHONY: seed-users
seed-users: ## Seed alice/bob/carol (+ stable TOTP secrets) — writes .demo-users.env once, creates the curity-demo-users Secret ('make users' prints the cards)
	@NS_CURITY=$(NS_CURITY) bash scripts/seed-curity-users.sh; \
	  $(call restart_if_exists,$(NS_CURITY),curity)

.PHONY: seed-license
seed-license: ## Install the Curity license secret from ./license.json
	@test -f license.json || { echo "license.json not found in repo root — run 'make demo-inputs' or copy it here"; exit 1; }; \
	  kubectl create namespace $(NS_CURITY) --dry-run=client -o yaml | kubectl apply -f - >/dev/null; \
	  kubectl -n $(NS_CURITY) create secret generic curity-license \
	    --from-file=license.json=license.json \
	    --dry-run=client -o yaml | kubectl apply -f -; \
	  $(call restart_if_exists,$(NS_CURITY),curity)

# restart-if-exists: rollout-restart $2 in ns $1 only when it's already deployed.
# $1=namespace $2=deployment
define restart_if_exists
	if kubectl -n $(1) get deploy $(2) >/dev/null 2>&1; then \
	  kubectl -n $(1) rollout restart deploy/$(2); \
	  kubectl -n $(1) rollout status deploy/$(2) --timeout=120s; \
	else echo "  (deploy/$(2) not created yet — secret is ready for the next 'make apply')"; fi
endef

.PHONY: seed-web-secret
seed-web-secret: ## Create web-secrets (autogen AUTH_SECRET + web client secret = Password1)
	@kubectl create namespace $(NS_WEB) --dry-run=client -o yaml | kubectl apply -f - >/dev/null; \
	  kubectl -n $(NS_WEB) create secret generic web-secrets \
	    --from-literal=AUTH_SECRET=$$(openssl rand -hex 32) \
	    --from-literal=CURITY_CLIENT_SECRET=Password1 \
	    --dry-run=client -o yaml | kubectl apply -f -; \
	  $(call restart_if_exists,$(NS_WEB),web)

.PHONY: seed-llm-secret
seed-llm-secret: ## Create the agentgateway LLM provider secret (from .demo.env if present, else prompt)
	@if [ -f .demo.env ]; then . ./.demo.env; fi; \
	  k="$${LLM_API_KEY:-$$AZURE_OPENAI_API_KEY}"; \
	  if [ -z "$$k" ]; then read -r -s -p "LLM_API_KEY: " k; echo; fi; \
	  test -n "$$k" || { echo "LLM_API_KEY empty — abort"; exit 1; }; \
	  kubectl create namespace $(NS_MCP) --dry-run=client -o yaml | kubectl apply -f - >/dev/null; \
	  kubectl -n $(NS_MCP) create secret generic agentgateway-llm \
	    --from-literal=LLM_API_KEY="$$k" \
	    --dry-run=client -o yaml | kubectl apply -f -; \
	  $(call restart_if_exists,$(NS_MCP),agentgateway)

.PHONY: render-gateway-config
render-gateway-config: ## Render .gen/agentgateway-config.yaml from .demo.env (run by `make apply`)
	bash scripts/render-gateway-config.sh

.PHONY: configure-llm
configure-llm: render-gateway-config ## Switch LLM provider: re-render, update the ConfigMap, restart the gateway
	kubectl -n $(NS_MCP) create configmap agentgateway-config \
	  --from-file=config.yaml=.gen/agentgateway-config.yaml \
	  --dry-run=client -o yaml | kubectl apply -f -
	$(call restart_if_exists,$(NS_MCP),agentgateway)

.PHONY: validate-llm
validate-llm: ## Validate every provider fragment against the pinned agentgateway image
	bash scripts/validate-llm-providers.sh
	bash scripts/test-render-gateway-config.sh

# CIMD ephemeral clients authenticate with private_key_jwt — no shared secret.
# We generate an RSA-2048 keypair and store only the PKCS8 PEM private key; the
# agent derives its public JWK at startup and publishes it at its JWKS endpoint.
.PHONY: seed-agent-key
seed-agent-key: ## Generate the agent-copilot RSA keypair (private_key_jwt client auth)
	@pem=$$(openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 2>/dev/null); \
	  test -n "$$pem" || { echo "key generation failed — abort"; exit 1; }; \
	  kubectl create namespace $(NS_AGENTS) --dry-run=client -o yaml | kubectl apply -f - >/dev/null; \
	  kubectl -n $(NS_AGENTS) create secret generic agent-copilot-curity \
	    --from-literal=CURITY_AGENT_PRIVATE_KEY_PEM="$$pem" \
	    --dry-run=client -o yaml | kubectl apply -f -; \
	  $(call restart_if_exists,$(NS_AGENTS),agent-copilot)

.PHONY: seed-specialist-key
seed-specialist-key: ## Generate the agent-specialist RSA keypair (private_key_jwt client auth)
	@pem=$$(openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 2>/dev/null); \
	  test -n "$$pem" || { echo "key generation failed — abort"; exit 1; }; \
	  kubectl create namespace $(NS_AGENTS) --dry-run=client -o yaml | kubectl apply -f - >/dev/null; \
	  kubectl -n $(NS_AGENTS) create secret generic agent-specialist-curity \
	    --from-literal=CURITY_AGENT_PRIVATE_KEY_PEM="$$pem" \
	    --dry-run=client -o yaml | kubectl apply -f -; \
	  $(call restart_if_exists,$(NS_AGENTS),agent-specialist)

# The two MCP servers are demo-only static clients with the fixed secret
# "Password1" (its SHA-256 crypt is committed in k8s/curity/configmap.yaml).
.PHONY: seed-mcp-ops-secret
seed-mcp-ops-secret: ## Seed the mcp-ops client secret (fixed demo value "Password1")
	@kubectl create namespace $(NS_MCP) --dry-run=client -o yaml | kubectl apply -f - >/dev/null; \
	  kubectl -n $(NS_MCP) create secret generic mcp-ops-curity \
	    --from-literal=CURITY_CLIENT_SECRET=Password1 \
	    --dry-run=client -o yaml | kubectl apply -f -; \
	  $(call restart_if_exists,$(NS_MCP),mcp-ops)

.PHONY: seed-mcp-inspect-secret
seed-mcp-inspect-secret: ## Seed the mcp-inspect client secret (fixed demo value "Password1")
	@kubectl create namespace $(NS_MCP) --dry-run=client -o yaml | kubectl apply -f - >/dev/null; \
	  kubectl -n $(NS_MCP) create secret generic mcp-inspect-curity \
	    --from-literal=CURITY_CLIENT_SECRET=Password1 \
	    --dry-run=client -o yaml | kubectl apply -f -; \
	  $(call restart_if_exists,$(NS_MCP),mcp-inspect)

# The agentgateway is a confidential client_secret_basic client (fixed demo secret
# "Password1"); its SHA-256 crypt is committed in k8s/curity/configmap.yaml.
.PHONY: seed-gateway-secret
seed-gateway-secret: ## Seed the agentgateway client secret (fixed demo value "Password1")
	@kubectl create namespace $(NS_MCP) --dry-run=client -o yaml | kubectl apply -f - >/dev/null; \
	  kubectl -n $(NS_MCP) create secret generic agentgateway-curity \
	    --from-literal=CURITY_CLIENT_SECRET=Password1 \
	    --dry-run=client -o yaml | kubectl apply -f -; \
	  $(call restart_if_exists,$(NS_MCP),agentgateway)

# ============================================================================
# Validation + health checks
# ============================================================================
.PHONY: status
status: ## Show pod health across every demo namespace
	@for ns in $(NS_CURITY) $(NS_WEB) $(NS_AGENTS) $(NS_MCP) $(NS_APIS) prod spire spire-server spire-system istio-system $(NS_INGRESS) telemetry; do \
	  echo "=== $$ns ==="; \
	  kubectl -n $$ns get pods --no-headers 2>/dev/null || echo "  (namespace not present)"; \
	  echo; \
	done
	@echo "=== routing ==="; \
	bash scripts/cluster-routing.sh check || echo "  (run 'make routing' to fix)"
	@echo "=== apis-waypoint JWKS ==="; \
	NS_CURITY=$(NS_CURITY) NS_APIS=$(NS_APIS) bash scripts/jwks-guard.sh check || echo "  (run 'make jwks-heal' to fix)"

.PHONY: smoke
smoke: routing-check jwks-check smoke-mcp-discovery smoke-obo smoke-a2a smoke-stepup smoke-llm smoke-mcp-protocol smoke-gateway-authz ## Run all auth/authz smoke tests
	@echo "==> All smoke tests passed."

.PHONY: smoke-mcp-discovery
smoke-mcp-discovery: ## Smoke: MCP-spec discovery chain (401 → RFC 9728 → RFC 8414) at the gateway + origin 401 challenges. Needs no token.
	bash scripts/smoke-mcp-discovery.sh

.PHONY: smoke-obo
smoke-obo: ## Smoke: single OBO hop (user → copilot → mcp-inspect). Needs SMOKE_SUBJECT_TOKEN.
	bash scripts/smoke-token-exchange.sh

.PHONY: smoke-a2a
smoke-a2a: ## Smoke: A2A delegation + privileged restart (… → specialist → mcp-ops → ops-api)
	bash scripts/smoke-a2a.sh

.PHONY: smoke-stepup
smoke-stepup: ## Smoke: RFC 9470 step-up (MFA for ops:write) + role-based denial (Bob)
	bash scripts/smoke-stepup.sh

.PHONY: smoke-llm
smoke-llm: ## Smoke: identity-bound LLM egress (user → agent → gateway /llm → provider). Needs SMOKE_SUBJECT_TOKEN.
	bash scripts/smoke-llm.sh

.PHONY: smoke-mcp-protocol
smoke-mcp-protocol: ## Smoke: MCP revision negotiated across agentgateway + tier filtering. Needs SMOKE_SUBJECT_TOKEN.
	bash scripts/smoke-mcp-protocol.sh

.PHONY: smoke-gateway-authz
smoke-gateway-authz: ## Smoke: gateway-side per-tool role split + namespace confinement. Needs SMOKE_SUBJECT_TOKEN.
	bash scripts/smoke-gateway-authz.sh

# ============================================================================
# MCP Inspector (tool tour) — see the header of scripts/mint-mcp-token.sh for why
# Inspector connects to the agentgateway rather than to an MCP server directly.
# ============================================================================
MCP_INSPECTOR_READ_PORT ?= 8080
MCP_INSPECTOR_WRITE_PORT ?= 8081

# Mint a token + port-forward, then print the Inspector connect details.
# Forwards the AGENTGATEWAY, not the MCP server: the minted token is
# aud=mcp-gateway, and the MCP servers require an act-chain that only the
# gateway's exchange-shim can produce. See scripts/mint-mcp-token.sh header.
#
# Protocol Era is a REQUIRED step, not a nicety: our MCP servers run
# `legacy: 'reject'` (2026-07-28 only), while Inspector defaults its era to
# Legacy. Left on the default it sends a 2025 `initialize`, the gateway forwards
# that upstream verbatim, and the server refuses — the connect just fails.
# Args: $(1)=target (inspect|ops) $(2)=gateway route path $(3)=local port
define inspect-tmpl
	@token=$$(bash scripts/mint-mcp-token.sh $(1)) || exit $$?; \
	printf '\n\033[36m=== MCP Inspector connect details ===\033[0m\n'; \
	printf '  Transport: Streamable HTTP\n  URL:       http://localhost:%s%s\n' "$(3)" "$(2)"; \
	printf '  Bearer:    %s\n\n' "$$token"; \
	printf '\033[33m  Options ▸ Protocol Era: set to "Modern" (or "Auto") — NOT the\n'; \
	printf '  default "Legacy", which this server refuses.\033[0m\n\n'; \
	printf 'In another terminal run:  \033[32mnpx @modelcontextprotocol/inspector\033[0m\n'; \
	printf 'then paste the URL + Bearer above. Port-forward holds this terminal (Ctrl-C to stop).\n\n'; \
	kubectl -n mcp port-forward svc/agentgateway $(3):8080
endef

.PHONY: mcp-inspector-read
mcp-inspector-read: ## Inspect the read tier via the gateway (mint token + port-forward). Needs SMOKE_SUBJECT_TOKEN.
	$(call inspect-tmpl,inspect,/inspect/mcp,$(MCP_INSPECTOR_READ_PORT))

.PHONY: mcp-inspector-write
mcp-inspector-write: ## Inspect the write tier via the gateway. Needs an MFA (acr=mfa) SMOKE_SUBJECT_TOKEN.
	$(call inspect-tmpl,ops,/ops/mcp,$(MCP_INSPECTOR_WRITE_PORT))

# ============================================================================
# End-to-end orchestration
# ============================================================================
.PHONY: demo-inputs
demo-inputs: ## Gather the license file + LLM provider credentials up front (interactive)
	@bash scripts/demo-inputs.sh

# `demo-inputs` runs first so the only two interactive inputs (license.json +
# LLM provider credentials) are collected up front; everything after it runs
# unattended.
.PHONY: demo
demo: tools-check demo-inputs kind-up certs platform seed-secrets images apply ## Stand up EVERYTHING on a fresh KIND cluster (one command)
	@echo ""
	@echo "==> Platform, secrets, images, and manifests are all deployed."
	@echo "    alice, bob and carol are seeded into Curity — their credentials and"
	@echo "    authenticator (TOTP) QR codes are printed below the URLs."
	@echo ""
	@echo "    TLS note: the mkcert root CA was NOT added to your keychain, so the"
	@echo "    browser will warn on https://app.localtest.me (safe to proceed)."
	@echo "    (Optional) To trust the CA and remove the warnings: make trust-ca  (undo: mkcert -uninstall)"
	@$(MAKE) --no-print-directory urls
	@$(MAKE) --no-print-directory users
	@echo "    Setup + troubleshooting: README.md · system design: docs/architecture.md"
	@echo ""

.PHONY: urls
urls: ## Print every browser-exposed URL (also shown at the end of `make demo`)
	@printf '\n'
	@printf '  ═══════════════════════════════════════════════════════════\n'
	@printf '   🌐  Browser-exposed URLs  —  all over HTTPS via the edge\n'
	@printf '  ═══════════════════════════════════════════════════════════\n'
	@printf '\n'
	@printf '  Apps  —  open these in your browser\n'
	@printf '    %-32s https://$(HOST_APP)\n'          'Demo app (copilot UI)'
	@printf '    %-32s https://$(HOST_CURITY_ADMIN)/admin\n' 'Curity Admin UI'
	@printf '    %-32s https://$(HOST_GRAFANA)\n'      'Grafana (OTel traces)'
	@printf '\n'
	@printf '  Identity & metadata  —  inspect the OAuth / SPIFFE plumbing\n'
	@printf '    %-41s https://$(HOST_CURITY)/oauth/v2/oauth-anonymous/.well-known/openid-configuration\n' 'Curity OIDC discovery'
	@printf '    %-41s https://$(HOST_COPILOT)/.well-known/oauth-client\n'              'Copilot ai-agent client metadata (CIMD)'
	@printf '    %-41s https://$(HOST_SPECIALIST)/.well-known/oauth-client\n'           'Specialist ai-agent client metadata'
	@printf '    %-41s https://$(HOST_MCP_OPS)/.well-known/oauth-protected-resource\n'  'mcp-ops resource metadata'
	@printf '    %-41s https://$(HOST_MCP_INSPECT)/.well-known/oauth-protected-resource\n'  'mcp-inspect resource metadata'
	@printf '    %-41s https://$(HOST_MCP_GATEWAY)/.well-known/oauth-protected-resource/inspect/mcp\n' 'agentgateway PRM (read tier)'
	@printf '    %-41s https://$(HOST_MCP_GATEWAY)/.well-known/oauth-protected-resource/ops/mcp\n' 'agentgateway PRM (write tier)'
	@printf '    %-41s https://$(HOST_CURITY)/.well-known/oauth-authorization-server/oauth/v2/oauth-anonymous\n' 'Curity RFC 8414 metadata'
	@printf '\n'
	@printf '  Sign in as one of the demo personas — credentials + TOTP QR codes: make users\n'
	@printf '\n'

.PHONY: users
users: ## Print the demo personas: usernames, roles, passwords, otpauth URIs + QR codes (also shown at the end of `make demo`)
	@bash scripts/seed-curity-users.sh --print

# ============================================================================
# Teardown + diagnostics
# ============================================================================
# Same fail-fast ordering as 'reset': a read-only Docker makes 'kind delete' and the
# image removal below fail, and the image removal is silent ('-' prefix + 2>/dev/null),
# so without the preflight this wipes node_modules/certs and reports success anyway.
.PHONY: clean
clean: docker-writable kind-down ## Tear down the cluster and remove local artifacts + built images
	rm -rf node_modules .turbo
	rm -rf $(CERT_DIR)
	# Remove the locally-built demo images so a fresh `make images` rebuilds clean.
	-docker image rm -f $(addprefix ai-agents-demo/,$(addsuffix :dev,$(IMAGE_NAMES))) 2>/dev/null

.PHONY: docker-writable
docker-writable: ## Verify the Docker daemon can WRITE to its own storage (a read-only Docker Desktop VM still answers 'docker info')
	@bash scripts/docker-writable.sh

# 'docker-writable' runs BEFORE 'kind-down' on purpose: a wedged Docker makes the
# prune below fail anyway, and without the preflight the cluster is destroyed first,
# leaving a failed reset strictly worse off than not running it.
.PHONY: reset
reset: docker-writable kind-down ## Recover from a wedged cluster: drop KIND + reclaim docker build cache
	@# 'kind-down' is '-' prefixed so a missing cluster is not an error; that also hides a
	@# genuine teardown failure, so verify the cluster is actually gone before continuing.
	@kind get clusters 2>/dev/null | grep -q '^$(CLUSTER_NAME)$$' && { \
		echo "ERROR: cluster '$(CLUSTER_NAME)' still exists after 'kind delete' - teardown failed."; \
		echo "  Inspect with: docker ps -a --filter name=$(CLUSTER_NAME)"; \
		exit 1; } || true
	docker builder prune -af
	@echo ""
	@echo "Build cache reclaimed. To reclaim more (review first):"
	@echo "  docker container prune -f   # stopped containers"
	@echo "  docker image prune -af      # images not used by any container"
	@echo "  docker volume prune -f      # unused anonymous volumes"
	@echo ""
	@echo "Then: make demo"

.PHONY: doctor
doctor: ## Show Docker + KIND disk pressure (run before 'make demo' if something's off)
	@echo "=== Docker storage writability ==="
	@bash scripts/docker-writable.sh --report
	@echo ""
	@echo "=== Docker disk usage ==="
	@docker system df 2>/dev/null || true
	@echo ""
	@echo "=== KIND node filesystems (if cluster is up) ==="
	@docker exec $(CLUSTER_NAME)-control-plane df -h / /tmp 2>/dev/null || echo "(KIND cluster not running)"
	@echo ""
	@echo "=== Stopped containers ==="
	@docker ps -a --filter status=exited --format 'table {{.ID}}\t{{.Image}}\t{{.Names}}' 2>/dev/null | head -10
