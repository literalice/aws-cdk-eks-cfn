import { Construct } from 'constructs';
import { Stack, RemovalPolicy, ResourceEnvironment, Size, CfnOutput, Token, Tags, Annotations } from "aws-cdk-lib";
import { aws_iam as iam } from "aws-cdk-lib";
import { aws_ec2 as ec2 } from "aws-cdk-lib";
import { aws_eks as eks } from "aws-cdk-lib";
import { AutoScalingGroup } from "aws-cdk-lib/aws-autoscaling";
import { ILayerVersion } from "aws-cdk-lib/aws-lambda";
import { AwsAuth } from "./aws-auth";

export interface ClusterProps extends eks.ClusterProps {
  adminRole: iam.IRole,
  ipFamily?: 'ipv4' | 'ipv6'
}

export class Cluster extends Construct implements eks.ICluster {
  public readonly legacyCluster: eks.ICluster;

  stack: Stack;
  env: ResourceEnvironment;
  connections: ec2.Connections;

  vpc: ec2.IVpc;
  clusterName: string;
  clusterArn: string;
  clusterEndpoint: string;
  clusterCertificateAuthorityData: string;
  clusterSecurityGroupId: string;
  clusterSecurityGroup: ec2.ISecurityGroup;
  clusterEncryptionConfigKeyArn: string;
  openIdConnectProvider: iam.IOpenIdConnectProvider;
  kubectlRole?: iam.IRole | undefined;
  kubectlEnvironment?: { [key: string]: string; } | undefined;
  kubectlSecurityGroup?: ec2.ISecurityGroup | undefined;
  kubectlPrivateSubnets?: ec2.ISubnet[] | undefined;
  kubectlLambdaRole?: iam.IRole | undefined;
  kubectlLayer?: ILayerVersion | undefined;
  kubectlProvider?: eks.IKubectlProvider | undefined;
  kubectlMemory?: Size | undefined;
  clusterHandlerSecurityGroup?: ec2.ISecurityGroup | undefined;
  onEventLayer?: ILayerVersion | undefined;
  prune: boolean;

  private _awsAuth: AwsAuth;

  private _cluster: eks.CfnCluster;
  
  constructor(scope: Construct, id: string, props: ClusterProps) {
    super(scope, id);

    this.stack = Stack.of(this);
    this.prune = props.prune ?? true;
    this.vpc = props.vpc || new ec2.Vpc(this, 'DefaultVpc');
    this.kubectlLambdaRole = props.kubectlLambdaRole ? props.kubectlLambdaRole : undefined;

    this.tagSubnets();

    const clusterRole = new iam.Role(this, 'ClusterRole', {
      assumedBy: new iam.ServicePrincipal('eks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSClusterPolicy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSVPCResourceController'),
      ],
    });

    const securityGroup = props.securityGroup || new ec2.SecurityGroup(this, 'ControlPlaneSecurityGroup', {
      vpc: this.vpc,
      description: 'EKS Control Plane Security Group',
    });

    if (!props.clusterName) throw Error();
    this.clusterName = props.clusterName;

    const endpointAccess = props.endpointAccess ?? eks.EndpointAccess.PUBLIC_AND_PRIVATE;

    this._cluster = new eks.CfnCluster(this, "Resource", {
      resourcesVpcConfig: {
        securityGroupIds: [securityGroup.securityGroupId],
        subnetIds: this.vpc.privateSubnets.map(s => s.subnetId),
        endpointPrivateAccess: endpointAccess._config.privateAccess,
        endpointPublicAccess: endpointAccess._config.publicAccess,
      },
      roleArn: clusterRole.roleArn,
  
      // the properties below are optional
      kubernetesNetworkConfig: {
        ipFamily: props.ipFamily ? props.ipFamily : 'ipv4',
      },

      name: props.clusterName,
      tags: [
        {
          key: 'Name',
          value: props.clusterName,
        },
      ],
      ...(props.secretsEncryptionKey ? {
        encryptionConfig: [{
          provider: {
            keyArn: props.secretsEncryptionKey.keyArn,
          },
          resources: ['secrets'],
        }],
      } : {}),
      version: (props.version ? props.version : eks.KubernetesVersion.V1_21).version,
    });

    this._cluster.node.addDependency(this.vpc);
    
    this.clusterArn = this._cluster.attrArn;
    this.clusterEndpoint = this._cluster.attrEndpoint;

    this.openIdConnectProvider = new eks.OpenIdConnectProvider(this, 'OidcProvider', {
      url: this._cluster.attrOpenIdConnectIssuerUrl,
    });

    this.clusterCertificateAuthorityData = this._cluster.attrCertificateAuthorityData;
    this.clusterSecurityGroupId = this._cluster.attrClusterSecurityGroupId;
    this.clusterEncryptionConfigKeyArn = this._cluster.attrEncryptionConfigKeyArn;
    this.kubectlEnvironment = props.kubectlEnvironment;
    this.kubectlLayer = props.kubectlLayer;
    this.kubectlMemory = props.kubectlMemory;
    this.kubectlRole = props.adminRole;

    this.clusterSecurityGroupId = this._cluster.attrClusterSecurityGroupId;
    this.clusterSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(this, 'ClusterSecurityGroup', this.clusterSecurityGroupId);

    this.connections = new ec2.Connections({
      securityGroups: [this.clusterSecurityGroup, securityGroup],
      defaultPort: ec2.Port.tcp(443), // Control Plane has an HTTPS API
    });

    const updateConfigCommandPrefix = `aws eks update-kubeconfig --name ${this.clusterName}`;
    const getTokenCommandPrefix = `aws eks get-token --cluster-name ${this.clusterName}`;
    const commonCommandOptions = [`--region ${this.stack.region}`];

    const mastersRole = props.mastersRole ?? new iam.Role(this, 'MastersRole', {
      assumedBy: new iam.AccountRootPrincipal(),
    });

    // map the IAM role to the `system:masters` group.
    this.awsAuth.addMastersRole(mastersRole);
    commonCommandOptions.push(`--role-arn ${mastersRole.roleArn}`);

    const outputConfigCommand = props.outputConfigCommand ?? true;
    if (outputConfigCommand) {
      const postfix = commonCommandOptions.join(' ');
      new CfnOutput(this, 'ConfigCommand', { value: `${updateConfigCommandPrefix} ${postfix}` });
      new CfnOutput(this, 'GetTokenCommand', { value: `${getTokenCommandPrefix} ${postfix}` });
    }
  }

  addServiceAccount(id: string, options?: eks.ServiceAccountOptions): eks.ServiceAccount {
    return new eks.ServiceAccount(this, id, {
      ...options,
      cluster: this,
    });
  }
  addManifest(id: string, ...manifest: Record<string, any>[]): eks.KubernetesManifest {
    return new eks.KubernetesManifest(this, `manifest-${id}`, { cluster: this, manifest });
  }
  addHelmChart(id: string, options: eks.HelmChartOptions): eks.HelmChart {
    return new eks.HelmChart(this, `chart-${id}`, { cluster: this, ...options });
  }
  addCdk8sChart(id: string, chart: Construct, options?: eks.KubernetesManifestOptions): eks.KubernetesManifest {
    throw new Error("Method not implemented.");
  }
  connectAutoScalingGroupCapacity(autoScalingGroup: AutoScalingGroup, options: eks.AutoScalingGroupOptions): void {
    throw new Error("Method not implemented.");
  }
  applyRemovalPolicy(policy: RemovalPolicy): void {
    throw new Error("Method not implemented.");
  }

  public get awsAuth() {
    if (!this._awsAuth) {
      this._awsAuth = new AwsAuth(this, 'AwsAuth', { cluster: this });
    }

    return this._awsAuth;
  }

  public addNodegroupCapacity(id: string, options?: eks.NodegroupOptions): eks.Nodegroup {
    const nodegroup = new eks.Nodegroup(this, `Nodegroup${id}`, {
      cluster: this,
      ...options,
    });
    this.awsAuth.addRoleMapping(nodegroup.role, {
      username: 'system:node:{{EC2PrivateDNSName}}',
      groups: [
        'system:bootstrappers',
        'system:nodes',
      ],
    });
    nodegroup.node.addDependency(this._cluster);
    return nodegroup;
  }

  public static fromClusterAttributes(scope: Construct, id: string, attrs: eks.ClusterAttributes): eks.ICluster {
    return eks.Cluster.fromClusterAttributes(scope, id, attrs);
  }

  private tagSubnets() {
    const tagAllSubnets = (type: string, subnets: ec2.ISubnet[], tag: string) => {
      for (const subnet of subnets) {
        // if this is not a concrete subnet, attach a construct warning
        if (!ec2.Subnet.isVpcSubnet(subnet)) {
          // message (if token): "could not auto-tag public/private subnet with tag..."
          // message (if not token): "count not auto-tag public/private subnet xxxxx with tag..."
          const subnetID = Token.isUnresolved(subnet.subnetId) || Token.isUnresolved([subnet.subnetId]) ? '' : ` ${subnet.subnetId}`;
          Annotations.of(this).addWarning(`Could not auto-tag ${type} subnet${subnetID} with "${tag}=1", please remember to do this manually`);
          continue;
        }

        Tags.of(subnet).add(tag, '1');
      }
    }

    // https://docs.aws.amazon.com/eks/latest/userguide/network_reqs.html
    tagAllSubnets('private', this.vpc.privateSubnets, 'kubernetes.io/role/internal-elb');
    tagAllSubnets('public', this.vpc.publicSubnets, 'kubernetes.io/role/elb');
  }
}