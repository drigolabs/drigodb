# The inner loop: edit src/, see it running, in seconds.
#
#   scripts/kind-up.sh && tilt up
#
# Tilt builds the API image and loads it straight into the kind node, so nothing
# is pushed anywhere and no registry is involved. That is the whole difference
# between this and the outer loop — `scripts/kind-up.sh` without --local pulls
# the PUBLISHED image, which is what a consumer gets and what you want before
# believing a change works.
#
# Deliberately NOT how anything is deployed. Tilt is a development tool, and a
# cluster it live-updates is not one reconciled from git. See
# docs/decisions/0002-gitops-for-the-control-plane.md.

CLUSTER = os.getenv('DRIGODB_KIND_CLUSTER', 'drigodb')
allow_k8s_contexts('kind-' + CLUSTER)

# Fails loudly rather than building against whatever cluster happens to be
# current — the alternative is discovering you deployed a dev image to DOKS.
if k8s_context() != 'kind-' + CLUSTER:
    fail('Tilt is pointed at %s, not kind-%s. Run scripts/kind-up.sh first.' % (k8s_context(), CLUSTER))

docker_build(
    'drigolabs/drigodb-api',
    context='.',
    dockerfile='Dockerfile',
    build_args={'DRIGODB_VERSION': 'tilt'},
    # Rebuild on source, not on docs or charts. A README edit should not roll
    # the control plane.
    only=['src/', 'package.json', 'package-lock.json', 'tsconfig.json', 'Dockerfile'],
)

# The same chart a consumer installs, so what runs here is what ships. Only the
# image differs, and only because it has to.
k8s_yaml(helm(
    'charts/drigodb',
    name='drigodb',
    namespace='drigodb-system',
    set=[
        'image.repository=drigolabs/drigodb-api',
        'image.pullPolicy=Never',
    ],
))

k8s_resource('drigodb-api', port_forwards=['18080:8080'], labels=['control-plane'])
