# Amazon EKS Construct using CloudFormation Library

## Usage

```typescript
const adminRole = new iam.Role(this, 'AdminRole', {
  assumedBy: new iam.AccountRootPrincipal(),
});
if (adminRole.assumeRolePolicy) {
  new iam.ServicePrincipal('cloudformation.amazonaws.com').addToAssumeRolePolicy(adminRole.assumeRolePolicy)
}
adminRole.addManagedPolicy(
  iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess'));

new ClusterStack(app, 'ClusterStack', adminRole, {
  synthesizer: new cdk.DefaultStackSynthesizer({
    cloudFormationExecutionRole: process.env.CLUSTER_ADMIN_ROLE_ARN,
  }),
});
```

```typescript
import { aws_eks as eks } from "aws-cdk-lib";
import { Cluster } from "@literalice/aws-cdk-eks-cfn";

export class ClusterStack extends Stack {
  constructor(scope: Construct, id: string, adminRole: iam.IRole, props?: StackProps) {
    super(scope, id, props);

    // ...

    const cluster = new Cluster(this, 'Cluster', {
      vpc,
      clusterName,
      endpointAccess: eks.EndpointAccess.PUBLIC_AND_PRIVATE,
      adminRole,
      mastersRole,
      ipFamily: 'ipv6',
      version: eks.KubernetesVersion.V1_21,
    });
  }
}
```