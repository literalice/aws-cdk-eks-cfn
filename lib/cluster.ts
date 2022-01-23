import { Construct } from 'constructs';
// import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Stack, RemovalPolicy, ResourceEnvironment, Size, CfnOutput } from "aws-cdk-lib";
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
  
  constructor(scope: Construct, id: string, props: ClusterProps) {
    super(scope, id);

    this.stack = Stack.of(this);

    const clusterRole = new iam.Role(this, 'ClusterRole', {
      assumedBy: new iam.ServicePrincipal('eks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSClusterPolicy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSVPCResourceController'),
      ],
    });

    if (!props.vpc) throw Error();
    this.vpc = props.vpc;

    if (!props.clusterName) throw Error();
    this.clusterName = props.clusterName;

    const endpointAccess = props.endpointAccess ?? eks.EndpointAccess.PUBLIC_AND_PRIVATE;

    const cfnCluster = new eks.CfnCluster(this, "Resource", {
      resourcesVpcConfig: {
        subnetIds: props.vpc.privateSubnets.map(s => s.subnetId),
        endpointPrivateAccess: endpointAccess._config.privateAccess,
        endpointPublicAccess: endpointAccess._config.publicAccess,
      },
      roleArn: clusterRole.roleArn,
  
      // the properties below are optional
      kubernetesNetworkConfig: {
        ipFamily: props.ipFamily ? props.ipFamily : 'ipv4',
      },

      name: props.clusterName,
      tags: [{
        key: 'Name',
        value: props.clusterName,
      }],
      version: (props.version ? props.version : eks.KubernetesVersion.V1_21).version,
    });
    this.clusterArn = cfnCluster.attrArn;
    this.clusterEndpoint = cfnCluster.attrEndpoint;

    this.openIdConnectProvider = new eks.OpenIdConnectProvider(this, 'OidcProvider', {
      url: cfnCluster.attrOpenIdConnectIssuerUrl,
    });

    this.clusterCertificateAuthorityData = cfnCluster.attrCertificateAuthorityData;
    this.clusterSecurityGroupId = cfnCluster.attrClusterSecurityGroupId;
    this.clusterEncryptionConfigKeyArn = cfnCluster.attrEncryptionConfigKeyArn;
    this.kubectlEnvironment = props.kubectlEnvironment;
    this.kubectlLayer = props.kubectlLayer;
    this.kubectlMemory = props.kubectlMemory;
    this.kubectlRole = props.adminRole;
    // this.clusterSecurityGroup = ec2.SecurityGroup.fromLookupById(this, 'ClusterSecurityGroup', cfnCluster.attrClusterSecurityGroupId);

    // this.connections = new ec2.Connections({
    //   securityGroups: [this.clusterSecurityGroup],
    //   defaultPort: ec2.Port.tcp(443), // Control Plane has an HTTPS API
    // });

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
    return nodegroup;
  }
}